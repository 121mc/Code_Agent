$ErrorActionPreference = 'Stop'
$agentDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($userPath -split ';' | Where-Object { $_.Trim() })
$remaining = @($entries | Where-Object {
    [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\') -ine $agentDirectory
})
$updatedPath = (@($agentDirectory) + $remaining) -join ';'
if ($updatedPath -cne $userPath) {
    [Environment]::SetEnvironmentVariable('Path', $updatedPath, 'User')
}
# Notify Explorer so newly opened terminals inherit the updated user PATH.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CodeAgentEnvironment {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr wParam,
        string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
[UIntPtr]$broadcastResult = [UIntPtr]::Zero
[void][CodeAgentEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x001A,
    [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$broadcastResult)
Write-Host 'code-agent added to user PATH. Restart existing terminals or IDEs before use.'
