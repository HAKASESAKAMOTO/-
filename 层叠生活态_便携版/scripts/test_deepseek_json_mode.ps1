[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $SystemPromptPath,

    [Parameter(Mandatory = $true)]
    [string] $ImagePath,

    [string] $PhotoId = 'photo_01',
    [string] $UserObjectLabel = '',
    [double[]] $UserObjectPoint = @(),
    [string] $UserEmotionLabel = '',
    [double] $Valence = 0,
    [double] $Arousal = 0,
    [string] $Model = 'deepseek-flash',
    [string] $Endpoint = 'https://api.deepseek.com/chat/completions',
    [string] $FallbackModel = 'qwen3.8-flash',
    [string] $FallbackEndpoint = 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions',
    [switch] $DisableFallback,
    [ValidateRange(1, 600)]
    [int] $TimeoutSec = 90,
    [int] $MaxTokens = 8000,
    [string] $OutputPath = '',
    [string] $InputJsonPath = ''
)

$ErrorActionPreference = 'Stop'

function Get-ImageMimeType([string] $Path) {
    switch ([IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        '.jpg' { return 'image/jpeg' }
        '.jpeg' { return 'image/jpeg' }
        '.webp' { return 'image/webp' }
        '.gif' { return 'image/gif' }
        default { return 'image/png' }
    }
}

function Assert-Condition([bool] $Condition, [string] $Message) {
    if (-not $Condition) {
        throw "JSON contract validation failed: $Message"
    }
}

function Test-BoundingBox($Candidate, [string] $Label) {
    Assert-Condition ($null -ne $Candidate -and @($Candidate).Count -eq 4) "$Label.bbox must contain four numbers"
    $values = @($Candidate | ForEach-Object { [double] $_ })
    $invalidValueCount = @($values | Where-Object { $_ -lt 0 -or $_ -gt 1 }).Count
    Assert-Condition ($invalidValueCount -eq 0) "$Label.bbox values must be in [0, 1]"
    Assert-Condition ($values[2] -gt 0 -and $values[3] -gt 0) "$Label.bbox width and height must be positive"
    Assert-Condition (($values[0] + $values[2]) -le 1) "$Label.bbox exceeds the right image edge"
    Assert-Condition (($values[1] + $values[3]) -le 1) "$Label.bbox exceeds the bottom image edge"
}

function Test-Candidate($Candidate, [string] $Label) {
    Assert-Condition ($null -ne $Candidate) "$Label is required"
    $categories = @('person', 'animal', 'plant', 'architecture', 'furniture', 'vehicle', 'daily_object', 'infrastructure', 'natural_object', 'other')
    $relations = @('context', 'contrast', 'connection', 'spatial', 'scale', 'echo')
    Assert-Condition (-not [string]::IsNullOrWhiteSpace([string] $Candidate.name)) "$Label.name is required"
    Assert-Condition ($categories -contains [string] $Candidate.category) "$Label.category is invalid"
    Assert-Condition ($relations -contains [string] $Candidate.relation) "$Label.relation is invalid"
    Assert-Condition (-not [string]::IsNullOrWhiteSpace([string] $Candidate.relation_evidence)) "$Label.relation_evidence is required"
    Assert-Condition (-not [string]::IsNullOrWhiteSpace([string] $Candidate.reason)) "$Label.reason is required"
    Test-BoundingBox $Candidate.bbox $Label
    Assert-Condition ($null -ne $Candidate.ratings) "$Label.ratings is required"
    foreach ($key in @('R', 'C', 'V', 'M', 'N')) {
        $value = $Candidate.ratings.$key
        Assert-Condition ($null -ne $value -and [int] $value -eq [double] $value -and [int] $value -ge 0 -and [int] $value -le 4) "$Label.ratings.$key must be an integer in [0, 4]"
    }
}

Assert-Condition (Test-Path -LiteralPath $SystemPromptPath -PathType Leaf) "System prompt file does not exist: $SystemPromptPath"
Assert-Condition (Test-Path -LiteralPath $ImagePath -PathType Leaf) "Image file does not exist: $ImagePath"

$systemPrompt = Get-Content -LiteralPath $SystemPromptPath -Raw
$imageBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $ImagePath).Path)
$imageData = [Convert]::ToBase64String($imageBytes)
$imageUrl = "data:$(Get-ImageMimeType $ImagePath);base64,$imageData"

$dynamicObject = [ordered]@{
    photo_id = $PhotoId
    user_object_label = $UserObjectLabel
    user_object_bbox = $null
    user_object_point = if ($UserObjectPoint.Count -eq 0) { $null } else { @($UserObjectPoint) }
    user_emotion_label = $UserEmotionLabel
    user_emotion_coordinates = [ordered]@{ valence = $Valence; arousal = $Arousal }
    asset_catalog = @()
}
if (-not [string]::IsNullOrWhiteSpace($InputJsonPath)) {
    $incoming = Get-Content -LiteralPath $InputJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Condition ([string] $incoming.photo_id -eq $PhotoId) 'input photo_id must match PhotoId'
    foreach ($key in @('photo_id','user_object_label','user_object_bbox','user_object_point','user_emotion_label','user_emotion_coordinates','asset_catalog')) {
        Assert-Condition ($null -ne $incoming.PSObject.Properties[$key]) "missing dynamic input field: $key"
        $dynamicObject[$key] = $incoming.$key
    }
    if ($null -ne $incoming.user_object_bbox) { Test-BoundingBox $incoming.user_object_bbox 'user_object' }
}
$dynamicInput = $dynamicObject | ConvertTo-Json -Compress -Depth 8

$request = [ordered]@{
    model = $Model
    messages = @(
        [ordered]@{ role = 'system'; content = $systemPrompt }
        [ordered]@{
            role = 'user'
            content = @(
                [ordered]@{ type = 'text'; text = $dynamicInput }
                [ordered]@{ type = 'image_url'; image_url = [ordered]@{ url = $imageUrl } }
            )
        }
    )
    response_format = [ordered]@{ type = 'json_object' }
    temperature = 0.1
    max_tokens = $MaxTokens
}

function Test-AnalysisResponse($response) {
    Assert-Condition (@($response.choices).Count -gt 0) 'response choices is empty'
    Assert-Condition ([string] $response.choices[0].finish_reason -eq 'stop') 'response did not finish normally'
    $content = [string] $response.choices[0].message.content
    Assert-Condition (-not [string]::IsNullOrWhiteSpace($content)) 'response content is empty'

    try {
        $result = $content | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw 'JSON contract validation failed: response content is not valid JSON'
    }

    $requiredFields = @('photo_id', 'status', 'ai_object', 'alternatives', 'scene_features', 'warnings')
    foreach ($field in $requiredFields) {
        Assert-Condition ($null -ne $result.PSObject.Properties[$field]) "missing root field: $field"
    }

    $statuses = @('success', 'no_reliable_object')
    $warningCodes = @('image_low_quality', 'user_target_ambiguous', 'object_location_uncertain', 'insufficient_distinct_objects', 'insufficient_visual_features')
    $featureLabels = @{
        L01 = '明亮'; L02 = '昏暗'; L03 = '柔光'; L04 = '硬光'; L05 = '逆光'; L06 = '斑驳光影'; L07 = '暖色调'; L08 = '冷色调'; L09 = '高对比'; L10 = '低对比'; L11 = '高饱和'; L12 = '低饱和'
        S01 = '拥挤'; S02 = '疏朗'; S03 = '开阔'; S04 = '围合'; S05 = '纵深'; S06 = '扁平'; S07 = '层叠'; S08 = '遮挡'; S09 = '留白'
        C01 = '对称'; C02 = '重复'; C03 = '规则排列'; C04 = '错落'; C05 = '散布'; C06 = '聚集'; C07 = '交错'; C08 = '对角线构图'; C09 = '中心聚焦'
        E01 = '室内'; E02 = '户外'; E03 = '城市'; E04 = '自然环境'; E05 = '生活空间'; E06 = '植被丰富'; E07 = '建筑密集'; E08 = '水域可见'
        F01 = '潮湿表面'; F02 = '雾霭'; F03 = '雨迹'; F04 = '积雪'; F05 = '强反射'; F06 = '运动模糊'; F07 = '粗糙纹理'; F08 = '光滑表面'
    }

    Assert-Condition ([string] $result.photo_id -eq $PhotoId) "photo_id does not match input ($PhotoId)"
    Assert-Condition ($statuses -contains [string] $result.status) "status is invalid"
    Assert-Condition (@($result.alternatives).Count -le 2) 'alternatives contains more than two candidates'
    Assert-Condition (@($result.scene_features).Count -le 3) 'scene_features contains more than three items'
    $unsupportedWarningCount = @($result.warnings | Where-Object { $warningCodes -notcontains [string] $_ }).Count
    Assert-Condition ($unsupportedWarningCount -eq 0) 'warnings contains an unsupported code'

    if ($result.status -eq 'success') {
        Test-Candidate $result.ai_object 'ai_object'
    } else {
        Assert-Condition ($null -eq $result.ai_object) 'ai_object must be null for no_reliable_object'
        Assert-Condition (@($result.alternatives).Count -eq 0) 'alternatives must be empty for no_reliable_object'
    }

    $candidateNames = @()
    if ($null -ne $result.ai_object) { $candidateNames += [string] $result.ai_object.name }
    foreach ($alternative in @($result.alternatives)) {
        Test-Candidate $alternative 'alternative'
        $candidateNames += [string] $alternative.name
    }
    Assert-Condition (($candidateNames | Select-Object -Unique).Count -eq $candidateNames.Count) 'candidate names contain duplicates'

    foreach ($feature in @($result.scene_features)) {
        Assert-Condition ($null -ne $featureLabels[[string] $feature.id]) "scene feature id is invalid: $($feature.id)"
        Assert-Condition ([string] $feature.label -eq $featureLabels[[string] $feature.id]) "scene feature label does not match id: $($feature.id)"
        Assert-Condition (-not [string]::IsNullOrWhiteSpace([string] $feature.evidence)) "scene feature evidence is required: $($feature.id)"
    }

    return @{ Content = $content; Result = $result }
}

function Get-RouteKey($route) {
    $file = Join-Path (Split-Path -Parent $PSScriptRoot) '.local/api-keys.json'
    [IO.Directory]::CreateDirectory((Split-Path -Parent $file)) | Out-Null
    if (-not [IO.File]::Exists($file)) {
        try {
            $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $bytes = [Text.Encoding]::UTF8.GetBytes('{"DEEPSEEK_API_KEY":"","RODIN_API_KEY":"","QWEN_API_KEY":""}')
                $stream.Write($bytes, 0, $bytes.Length)
            } finally { $stream.Dispose() }
        } catch [IO.IOException] { if (-not [IO.File]::Exists($file)) { throw 'API key file cannot be created' } }
    }
    try { $keys = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Invalid .local/api-keys.json; check the local API settings' }
    $key = $keys.($route.KeyVariable)
    if ($key -isnot [string] -or [string]::IsNullOrWhiteSpace($key) -or $key.Length -gt 4096 -or $key -match '\s') {
        throw 'API key is not configured or invalid; open api-keys.html'
    }
    return $key
}

$routes = @(@{ Name = 'line1'; Model = $Model; Endpoint = $Endpoint; KeyVariable = 'DEEPSEEK_API_KEY' })
if (-not $DisableFallback) {
    $routes += @{ Name = 'line2'; Model = $FallbackModel; Endpoint = $FallbackEndpoint; KeyVariable = 'QWEN_API_KEY' }
}
$routeFailures = @()
$selectedRoute = $null
foreach ($route in $routes) {
    $stage = 'credentials'
    try {
        $apiKey = Get-RouteKey $route
        $body = [ordered]@{}
        foreach ($key in $request.Keys) { $body[$key] = $request[$key] }
        $body.model = $route.Model
        if ($route.Name -eq 'line2') { $body.enable_thinking = $false }
        $requestBody = $body | ConvertTo-Json -Depth 12
        $stage = 'request'
        $response = Invoke-RestMethod -Uri $route.Endpoint -Headers @{ Authorization = "Bearer $apiKey"; 'Content-Type' = 'application/json' } -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($requestBody)) -TimeoutSec $TimeoutSec
        $stage = 'response_validation'
        $validated = Test-AnalysisResponse $response
        $selectedRoute = $route
        break
    } catch {
        $httpStatus = $null
        if ($null -ne $_.Exception.Response -and $null -ne $_.Exception.Response.StatusCode) {
            $httpStatus = [int] $_.Exception.Response.StatusCode
        }
        # Record controlled diagnostics only; provider errors may contain credentials or input.
        $routeFailures += [ordered]@{ route = $route.Name; model = $route.Model; stage = $stage; http_status = $httpStatus }
        Write-Warning "$($route.Name) ($($route.Model)) failed at $stage (HTTP $httpStatus)."
    }
}
if ($null -eq $selectedRoute) {
    throw "All analysis routes failed: $($routeFailures | ConvertTo-Json -Compress -Depth 4)"
}
$content = $validated.Content
$result = $validated.Result

if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    $outputDirectory = Split-Path -Parent $OutputPath
    if ($outputDirectory) { New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null }
    $content | Set-Content -LiteralPath $OutputPath -Encoding UTF8
}

[ordered]@{
    route = $selectedRoute.Name
    fallback_used = ($selectedRoute.Name -eq 'line2')
    route_failures = @($routeFailures)
    request_model = $selectedRoute.Model
    response_model = [string] $response.model
    request_id = [string] $response.id
    finish_reason = [string] $response.choices[0].finish_reason
    usage = $response.usage
    json_mode = $true
    contract_valid = $true
    status = [string] $result.status
    photo_id = [string] $result.photo_id
    ai_object = if ($null -eq $result.ai_object) { $null } else { [string] $result.ai_object.name }
    scene_features = @($result.scene_features | ForEach-Object { [string] $_.id })
    warnings = @($result.warnings)
    output_path = if ([string]::IsNullOrWhiteSpace($OutputPath)) { $null } else { (Resolve-Path -LiteralPath $OutputPath).Path }
} | ConvertTo-Json -Depth 12
