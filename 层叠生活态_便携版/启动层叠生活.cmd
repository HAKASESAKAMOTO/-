@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 层叠生活 Receiver
set "ROOT=%~dp0"
set "RECEIVER_PROJECT_ROOT=%ROOT:~0,-1%"
rem 全部使用包内自带的运行时：Node、PowerShell 7、Playwright Chromium。
set "PATH=%ROOT%runtime\node;%ROOT%runtime\pwsh;%PATH%"
set "PLAYWRIGHT_BROWSERS_PATH=%ROOT%runtime\ms-playwright"
set "POWERSHELL_EXE=%ROOT%runtime\pwsh\pwsh.exe"
if "%RECEIVER_HOST%"=="" set "RECEIVER_HOST=127.0.0.1"
if "%RECEIVER_PORT%"=="" set "RECEIVER_PORT=8790"
set "RECEIVER_URL=http://127.0.0.1:%RECEIVER_PORT%/"

rem 优先使用包内 Python，避免 Windows 的 Microsoft Store python 占位命令。
set "PYTHON_EXE="
if exist "%ROOT%hardware\runtime\python.exe" set "PYTHON_EXE=%ROOT%hardware\runtime\python.exe"
if not defined PYTHON_EXE (
  python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
  if not errorlevel 1 set "PYTHON_EXE=python"
)
if not defined PYTHON_EXE (
  py -3 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PYTHON_EXE=py"
)
if not defined PYTHON_EXE (
  echo [提示] 没有找到 Python 3。照片接收、情绪标注、AI 识别和看楼都能用，
  echo        但生成新的 3D 模型需要先安装 Python 3.9 以上版本。
  echo.
)

"%POWERSHELL_EXE%" -NoProfile -Command "try { $s=Invoke-RestMethod -TimeoutSec 1 '%RECEIVER_URL%health'; if($s.service -eq 'layered-ecology-receiver'){ exit 0 }; exit 1 } catch { exit 1 }"
if not errorlevel 1 (
  echo 端口 %RECEIVER_PORT% 上已经有一个 Receiver 在运行，请先关闭那个窗口。
  start "" "%RECEIVER_URL%"
  pause
  exit /b 1
)
start "" /b "%POWERSHELL_EXE%" -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 90;$i++){ try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%RECEIVER_URL%health' | Out-Null; Start-Process '%RECEIVER_URL%'; exit 0 } catch { Start-Sleep -Milliseconds 500 } }"
echo.
echo ==== 层叠生活 Receiver 正在运行：%RECEIVER_URL% ====
echo ==== 保持本窗口打开；关闭本窗口即停止服务 ====
echo.
"%ROOT%runtime\node\node.exe" "%ROOT%receiver\dist\src\index.js"
echo.
echo Receiver 已停止（退出码 %errorlevel%）。
pause
endlocal
