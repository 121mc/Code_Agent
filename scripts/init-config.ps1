param([string]$ConfigRoot = (Split-Path $PSScriptRoot -Parent))

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    Write-Host 'Configure an OpenAI-compatible API. Nothing is saved until a model is selected.'
    while ($true) {
        $baseUrl = (Read-Host 'Base URL (for example https://api.openai.com/v1)').Trim().TrimEnd('/')
        $parsedUrl = $null
        if (-not [Uri]::TryCreate($baseUrl, [UriKind]::Absolute, [ref]$parsedUrl) -or
            $parsedUrl.Scheme -notin @('http', 'https') -or $parsedUrl.UserInfo -or
            $parsedUrl.Query -or $parsedUrl.Fragment) {
            Write-Host 'Enter an HTTP(S) API base URL without credentials, query or fragment.'
            continue
        }

        $secureKey = Read-Host 'API key (hidden)' -AsSecureString
        $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        try {
            $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
            $secureKey.Dispose()
        }
        if ([string]::IsNullOrWhiteSpace($apiKey)) {
            Write-Host 'API key cannot be empty.'
            continue
        }

        try {
            Write-Host 'Fetching available models...'
            $response = Invoke-RestMethod -Uri ($baseUrl + '/models') -Method Get `
                -Headers @{ Authorization = ('Bearer ' + $apiKey) } -TimeoutSec 30 -MaximumRedirection 0
            $models = @($response.data | ForEach-Object {
                if ($_.id -is [string] -and -not [string]::IsNullOrWhiteSpace($_.id)) { $_.id }
            } | Sort-Object -Unique)
            if ($models.Count -eq 0) { throw 'No models returned.' }
        } catch {
            # Provider errors can echo credentials; never print raw response bodies.
            Write-Host 'Could not fetch a non-empty model list. Check the URL, key and /models support.'
            $apiKey = $null
            if ((Read-Host 'Press Enter to retry, or type q to quit') -eq 'q') { exit 1 }
            continue
        }

        for ($i = 0; $i -lt $models.Count; $i++) {
            $displayName = $models[$i] -replace '[\x00-\x1f\x7f]', ''
            Write-Host ('{0}. {1}' -f ($i + 1), $displayName)
        }
        do {
            $choice = Read-Host 'Select a model number (q to quit)'
            if ($choice -eq 'q') { exit 1 }
            $selection = 0
            $valid = [int]::TryParse($choice, [ref]$selection) -and $selection -ge 1 -and $selection -le $models.Count
            if (-not $valid) { Write-Host 'Enter one of the listed numbers.' }
        } until ($valid)

        $payload = @{
            CODE_AGENT_BASE_URL = $baseUrl
            CODE_AGENT_API_KEY = $apiKey
            CODE_AGENT_MODEL = $models[$selection - 1]
        } | ConvertTo-Json -Compress
        $payload | & node (Join-Path $PSScriptRoot 'write-env.mjs') $ConfigRoot
        if ($LASTEXITCODE -ne 0) { throw 'Configuration write failed.' }
        $payload = $null
        $apiKey = $null
        Write-Host 'Saved configuration to code-agent root .env.'
        break
    }
} catch {
    Write-Host 'Initialization failed. Check Node.js (20.19+) and write access to the project root.'
    exit 1
}
