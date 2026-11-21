# M4raCast Local Web Client Server (Zero-dependency PowerShell HTTP Server)
$port = 8080
$prefix = "http://localhost:$port/"
$webRoot = $PSScriptRoot

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
    Write-Host "====================================================" -ForegroundColor Cyan
    Write-Host "  M4raCast Web Client Server running at: " -NoNewline
    Write-Host $prefix -ForegroundColor Green
    Write-Host "  Press Ctrl+C to stop the server." -ForegroundColor Yellow
    Write-Host "====================================================" -ForegroundColor Cyan

    # Auto-open default browser
    Start-Process $prefix

    $mimeTypes = @{
        ".html" = "text/html; charset=utf-8"
        ".css"  = "text/css; charset=utf-8"
        ".js"   = "application/javascript; charset=utf-8"
        ".json" = "application/json"
        ".png"  = "image/png"
        ".svg"  = "image/svg+xml"
        ".ico"  = "image/x-icon"
    }

    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $urlPath = $request.Url.LocalPath
        if ($urlPath -eq "/" -or $urlPath -eq "" -or $urlPath.StartsWith("/stream") -or $urlPath.StartsWith("/connect")) {
            $urlPath = "/index.html"
        }

        $filePath = Join-Path $webRoot ($urlPath.TrimStart('/').Replace('/', '\'))

        if (Test-Path -Path $filePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $mime = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            
            $response.ContentType = $mime
            $response.ContentLength64 = $bytes.Length
            $response.AddHeader("Access-Control-Allow-Origin", "*")
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
            $err = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
            $response.OutputStream.Write($err, 0, $err.Length)
        }
        $response.Close()
    }
} finally {
    $listener.Stop()
    $listener.Close()
}

