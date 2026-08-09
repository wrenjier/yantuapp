param(
  [switch]$NoBrowser,
  [ValidateRange(1, 65535)]
  [int]$Port = 8765
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Get-Utf8Message([string]$Encoded) {
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Encoded))
}

$appRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$safeRoot = $appRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$url = "http://localhost:$Port"
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listenerStarted = $false

try {
  try {
    $listener.Start()
    $listenerStarted = $true
  } catch [System.Net.Sockets.SocketException] {
    $sameApp = $false
    try {
      $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2
      $sameApp = $probe.StatusCode -eq 200 -and $probe.Content -match 'id="clearSampleData"' -and $probe.Content -match 'entertainment-engine\.js'
    } catch {
      $sameApp = $false
    }

    if ($sameApp) {
      Write-Host ((Get-Utf8Message "56CU6YCU5aWW5Yqx5YaM5bey57uP5Zyo6L+Q6KGM77yaezB9") -f $url) -ForegroundColor Green
      if (-not $NoBrowser) { Start-Process $url }
      exit 0
    }

    [Console]::Error.WriteLine((Get-Utf8Message "5peg5rOV5ZCv5Yqo77ya56uv5Y+jIHswfSDlt7Looqvlhbbku5bnqIvluo/ljaDnlKjjgILor7flhbPpl63ljaDnlKjnqIvluo/vvIzmiJbov5DooYwgc3RhcnQtYXBwLnBzMSAtUG9ydCDlhbbku5bnq6/lj6Plj7fjgII=") -f $Port)
    exit 2
  }

  Write-Host ""
  Write-Host ("  " + (Get-Utf8Message "56CU6YCU5aWW5Yqx5YaM5q2j5Zyo6L+Q6KGM")) -ForegroundColor Green
  Write-Host ("  " + ((Get-Utf8Message "5omT5byA77yaezB9") -f $url)) -ForegroundColor Cyan
  Write-Host ("  " + (Get-Utf8Message "6K+35L+d5oyB5q2k56qX5Y+j5byA5ZCv77yb5oyJIEN0cmwrQyDmiJblhbPpl63nqpflj6PljbPlj6/lgZzmraLjgII=")) -ForegroundColor DarkGray
  Write-Host ""

  if (-not $NoBrowser) { Start-Process $url }

  $mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".png"  = "image/png"
    ".ico"  = "image/x-icon"
    ".svg"  = "image/svg+xml"
  }

  while ($true) {
    $client = $null
    try {
      $client = $listener.AcceptTcpClient()
      $stream = $client.GetStream()
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
      $requestLine = $reader.ReadLine()
      while ($reader.ReadLine()) { }

      $requestPath = "/"
      if ($requestLine -match "^[A-Z]+\s+([^\s]+)") { $requestPath = $Matches[1].Split("?")[0] }
      $served = $false
      try {
        $requestPath = [System.Uri]::UnescapeDataString($requestPath)
        if ($requestPath -eq "/") { $requestPath = "/index.html" }
        $relativePath = $requestPath.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
        $filePath = [System.IO.Path]::GetFullPath((Join-Path $appRoot $relativePath))
        $insideRoot = $filePath.StartsWith($safeRoot, [System.StringComparison]::OrdinalIgnoreCase)
        if ($insideRoot -and [System.IO.File]::Exists($filePath)) {
          $body = [System.IO.File]::ReadAllBytes($filePath)
          $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
          $contentType = if ($mimeTypes.ContainsKey($extension)) { $mimeTypes[$extension] } else { "application/octet-stream" }
          $header = "HTTP/1.1 200 OK`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
          $served = $true
        }
      } catch {
        # A malformed or inaccessible request path fails only this client.
      }

      if (-not $served) {
        $body = [System.Text.Encoding]::UTF8.GetBytes((Get-Utf8Message "6aG16Z2i5LiN5a2Y5Zyo"))
        $header = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
      }
      $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($headerBytes, 0, $headerBytes.Length)
      $stream.Write($body, 0, $body.Length)
      $stream.Flush()
    } catch [System.IO.IOException] {
      # Continue serving when a browser closes the connection early.
    } finally {
      if ($null -ne $client) { $client.Close() }
    }
  }
} finally {
  if ($listenerStarted) { $listener.Stop() }
}
