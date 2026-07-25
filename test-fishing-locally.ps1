# DEPRECATED — use setup-local.ps1 instead.
#
# This script cloned adamxgsb-hub/OpenMMO directly, which turns out to be wrong:
# that repo is not a GitHub fork, so it holds no Git LFS objects and you end up
# with pointer files instead of 3D models. setup-local.ps1 clones upstream (which
# owns the binaries), pulls LFS, then layers the fishing branches on top.

Write-Host "Use setup-local.ps1 instead - this script's clone order produced a" -ForegroundColor Yellow
Write-Host "model-less checkout (no Git LFS objects). Run:" -ForegroundColor Yellow
Write-Host "  powershell -ExecutionPolicy Bypass -File setup-local.ps1" -ForegroundColor Cyan
