param(
    [string]$Manifest = "$PSScriptRoot\..\examples\scene-input.json",
    [string]$Out = "$PSScriptRoot\..\..\..\data\model-production\demo",
    [string]$Blender = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Blender)) { throw "Blender executable not found: $Blender" }
& $Blender --background --factory-startup --python-exit-code 1 --python "$PSScriptRoot\build_scene.py" -- --manifest $Manifest --out $Out
if ($LASTEXITCODE -ne 0) { throw "Blender build failed: $LASTEXITCODE" }
