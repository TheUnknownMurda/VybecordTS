# VybecordTS — SMTC Reader (Windows Media Transport Controls)
# Long-running script: outputs one JSON line per poll cycle to stdout.
# Reads playback info from the active media session (Spotify, browser, etc.)
#
# Optimizations over naive approach:
#   1. Pre-computed WinRT generic methods (skip MakeGenericMethod reflection per tick)
#   2. Session caching (reuse last session, re-enumerate only every 10th tick)
#   3. Source name caching (hashtable per appId, skip regex matching)
#   4. Media properties caching (skip expensive TryGetMediaPropertiesAsync on same track)
#   5. Track change detection (duration/position/source delta)
#   6. Manual JSON construction (5-10x faster than ConvertTo-Json)
#   7. [Console]::WriteLine (bypass PowerShell pipeline overhead)

$ErrorActionPreference = 'SilentlyContinue'

# Force UTF-8 output (handles emoji in titles like 📚)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# ── Load WinRT ──
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]

# ── Pre-computed generic Await methods (avoid MakeGenericMethod per tick) ──
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskManager = $asTaskGeneric.MakeGenericMethod([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$asTaskMedia   = $asTaskGeneric.MakeGenericMethod([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$asTaskStream  = $asTaskGeneric.MakeGenericMethod([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
$asTaskUInt32  = $asTaskGeneric.MakeGenericMethod([uint32])

Function AwaitFast($WinRtTask, $precompiledMethod) {
    $netTask = $precompiledMethod.Invoke($null, @($WinRtTask))
    $null = $netTask.Wait(-1)
    $netTask.Result
}

# ── Session manager (one-time init) ──
$mgr = AwaitFast ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) $asTaskManager

# ── Source identification (cached per app ID — skip regex on repeat lookups) ──
$sourceCache = @{}

function Get-SourceName($appId) {
    if ($sourceCache.ContainsKey($appId)) { return $sourceCache[$appId] }
    $lower = ($appId -replace '\s','').ToLower()
    $result = 'unknown'
    if     ($lower -match 'spotify')                    { $result = 'spotify' }
    elseif ($lower -match 'apple\.?music|appleinc|itunes') { $result = 'apple_music' }
    elseif ($lower -match 'deezer')                     { $result = 'deezer' }
    elseif ($lower -match 'tidal')                      { $result = 'tidal' }
    elseif ($lower -match 'amazon\.?music|amzn')        { $result = 'amazon_music' }
    elseif ($lower -match 'chrome|google')              { $result = 'browser_chrome' }
    elseif ($lower -match 'firefox|mozilla')            { $result = 'browser_firefox' }
    elseif ($lower -match 'msedge|microsoft\.edge')     { $result = 'browser_edge' }
    elseif ($lower -match 'brave')                      { $result = 'browser_brave' }
    elseif ($lower -match 'opera')                      { $result = 'browser_opera' }
    elseif ($lower -match 'vlc')                        { $result = 'vlc' }
    elseif ($lower -match 'foobar')                     { $result = 'foobar2000' }
    elseif ($lower -match 'musicbee')                   { $result = 'musicbee' }
    elseif ($lower -match 'aimp')                       { $result = 'aimp' }
    elseif ($lower -match 'winamp')                     { $result = 'winamp' }
    elseif ($lower -match 'mediamonkey')                { $result = 'mediamonkey' }
    elseif ($lower -match 'groove')                      { $result = 'groove' }
    elseif ($lower -match 'wmplayer|windows\.media|zunevideo|zunemusic|microsoft\.media|msnvideo|movies&tv|mswindowsmusic') { $result = 'wmp' }
    $sourceCache[$appId] = $result
    return $result
}

function Get-SourcePriority($src) {
    switch ($src) {
        'spotify'      { return 10 }
        'apple_music'  { return 9 }
        'deezer'       { return 9 }
        'tidal'        { return 9 }
        'amazon_music' { return 8 }
        default {
            if ($src -match 'vlc|foobar|musicbee|aimp|winamp|mediamonkey|groove|wmp') { return 5 }
            if ($src -match 'browser_') { return 1 }
            return 0
        }
    }
}

# JSON escape: handle ", \, and control characters in track/artist/album strings
function JsonEsc([string]$s) {
    $s.Replace('\', '\\').Replace('"', '\"').Replace("`n", '\n').Replace("`r", '\r').Replace("`t", '\t')
}

# Signal ready
[Console]::WriteLine('{"ready":true}')

# ── State caches ──
$thumbPath = Join-Path $env:TEMP 'vybecord_thumb.jpg'
$lastThumbTitle = ''
$cachedSession = $null
$cachedSource = 'unknown'
$cachedSourceId = ''
$cachedTitle = ''
$cachedArtist = ''
$cachedAlbum = ''
$cachedDurRaw = [long]0
$lastPosRaw = [long]0
$pollCount = 0
$MAX_DUR = [long]86400000       # 24 hours in ms — anything above is live/invalid
$FULL_REFRESH_EVERY = 10        # Force full media properties refresh every 10 ticks (4s safety net)

# ── Poll loop ──
while ($true) {
    try {
        $pollCount++
        $bestSession = $null
        $bestSource = 'unknown'

        # ── Fast path: reuse cached session if still playing ──
        $needEnum = $true
        if ($null -ne $cachedSession) {
            try {
                $pb = $cachedSession.GetPlaybackInfo()
                if ($pb.PlaybackStatus -eq 4) {
                    $bestSession = $cachedSession
                    $bestSource = $cachedSource
                    # Re-enumerate periodically to catch priority changes (e.g. user opened Spotify)
                    $needEnum = ($pollCount % $FULL_REFRESH_EVERY -eq 0)
                }
            } catch {
                $cachedSession = $null
            }
        }

        # ── Slow path: enumerate all sessions (only if fast path failed or periodic check) ──
        if ($needEnum) {
            $bestPriority = if ($null -ne $bestSession) { Get-SourcePriority $bestSource } else { -1 }
            $sessions = $mgr.GetSessions()
            foreach ($s in $sessions) {
                $appId = $s.SourceAppUserModelId
                $src = Get-SourceName $appId
                try { $pb = $s.GetPlaybackInfo() } catch { continue }

                if ($pb.PlaybackStatus -eq 4) {
                    $pri = Get-SourcePriority $src
                    if ($pri -gt $bestPriority) {
                        $bestSession = $s
                        $bestSource = $src
                        $bestPriority = $pri
                    }
                }
            }
        }

        if ($null -ne $bestSession) {
            # Cache session for next tick
            $cachedSession = $bestSession
            $cachedSource = $bestSource

            # ── Timeline properties (always fresh — cheap ~0.3ms) ──
            $tl = $bestSession.GetTimelineProperties()
            $posRaw = [long]($tl.Position.TotalMilliseconds)
            $durRaw = [long]($tl.EndTime.TotalMilliseconds)

            $isLive = ($durRaw -le 0 -or $durRaw -gt $MAX_DUR)
            $durMs = if ($isLive) { 0 } else { [int]$durRaw }
            $posMs = if ($posRaw -gt $MAX_DUR) { 0 } else { [int]$posRaw }

            # Compensate for SMTC snapshot delay (skip for live — position unreliable)
            if (-not $isLive) {
                try {
                    $lastUpd = $tl.LastUpdatedTime
                    $now = [System.DateTimeOffset]::UtcNow
                    $elapsedMs = [int](($now - $lastUpd).TotalMilliseconds)
                    if ($elapsedMs -gt 0 -and $elapsedMs -lt 10000) {
                        $posMs = $posMs + $elapsedMs
                    }
                } catch {}
                if ($durMs -gt 0 -and $posMs -gt $durMs) { $posMs = $durMs }
            }

            # ── Track change detection ──
            $sourceId = [string]$bestSession.SourceAppUserModelId
            $durChanged = [System.Math]::Abs($durRaw - $cachedDurRaw) -gt 500
            $posJumped = $posRaw -lt ($lastPosRaw - 2000)
            $sourceChanged = $sourceId -ne $cachedSourceId
            $forceRefresh = ($pollCount % $FULL_REFRESH_EVERY -eq 0)
            $trackChanged = $durChanged -or $posJumped -or $sourceChanged -or $forceRefresh

            $lastPosRaw = $posRaw
            $thumbExtracted = $false

            # ── Media properties (expensive ~2-3ms — only on track change) ──
            if ($trackChanged) {
                $info = AwaitFast ($bestSession.TryGetMediaPropertiesAsync()) $asTaskMedia

                $cachedTitle = [string]$info.Title
                $cachedAlbum = [string]$info.AlbumTitle
                $cachedDurRaw = $durRaw
                $cachedSourceId = $sourceId

                # Build artist string — SMTC Artist field often has only the primary artist.
                # AlbumArtist may contain additional artists or the full list.
                $mainArtist = [string]$info.Artist
                $albumArtist = [string]$info.AlbumArtist
                $cachedArtist = $mainArtist
                if ($albumArtist.Length -gt $mainArtist.Length -and $albumArtist -match [regex]::Escape($mainArtist)) {
                    $cachedArtist = $albumArtist
                }
                elseif ($albumArtist.Length -gt 0 -and $albumArtist -ne $mainArtist -and $mainArtist -notmatch [regex]::Escape($albumArtist)) {
                    $cachedArtist = "$mainArtist, $albumArtist"
                }

                # Check if thumbnail file exists (may have been extracted by local-art.ts)
                $thumbFileExists = Test-Path $thumbPath
                $thumbFileAge = if ($thumbFileExists) { [int]((Get-Date) - (Get-Item $thumbPath).LastWriteTime).TotalSeconds } else { 9999 }

                # Reset thumb cache only when title changes AND thumb file is old or missing
                if ($cachedTitle -ne $lastThumbTitle -and $thumbFileAge -gt 5) {
                    $lastThumbTitle = ''
                }

                # Extract SMTC thumbnail on track change (YouTube, browsers, etc.)
                # Don't overwrite existing thumbnail file if SMTC doesn't have one (preserves local-art.ts extraction)
                try {
                    $thumbRef = $info.Thumbnail
                    if ($null -ne $thumbRef) {
                        $stream = $null
                        $reader = $null
                        try {
                            $stream = AwaitFast ($thumbRef.OpenReadAsync()) $asTaskStream
                            $sz = [uint32]$stream.Size
                            if ($sz -gt 0 -and $sz -lt 5000000) {
                                $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
                                AwaitFast ($reader.LoadAsync($sz)) $asTaskUInt32
                                $buf = [byte[]]::new($sz)
                                $reader.ReadBytes($buf)
                                [System.IO.File]::WriteAllBytes($thumbPath, $buf)
                                $lastThumbTitle = $cachedTitle
                                $thumbExtracted = $true
                            }
                        } finally {
                            if ($null -ne $reader) { try { $reader.Dispose() } catch {} }
                            if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
                        }
                    } elseif (Test-Path $thumbPath) {
                        # SMTC has no thumbnail but file exists (likely from local-art.ts)
                        # Keep the existing file and set thumb flag
                        $thumbExtracted = $true
                    }
                } catch {}
            } else {
                # Track didn't change — keep thumb flag if we have a cached thumbnail
                if ($lastThumbTitle -ne '') {
                    $thumbExtracted = $true
                }
            }

            # ── Manual JSON (5-10x faster than ConvertTo-Json) ──
            $t = JsonEsc $cachedTitle
            $a = JsonEsc $cachedArtist
            $al = JsonEsc $cachedAlbum
            $sc = JsonEsc $bestSource
            $sid = JsonEsc $cachedSourceId
            $il = if ($isLive) { 'true' } else { 'false' }
            $th = if ($thumbExtracted) { ',"thumb":true' } else { '' }

            [Console]::WriteLine('{"is_playing":true,"title":"' + $t + '","artist":"' + $a + '","album":"' + $al + '","position_ms":' + $posMs + ',"duration_ms":' + $durMs + ',"source":"' + $sc + '","source_id":"' + $sid + '","is_live":' + $il + $th + '}')
        }
        else {
            $cachedSession = $null
            [Console]::WriteLine('{"is_playing":false}')
        }
    }
    catch {
        [Console]::WriteLine('{"is_playing":false,"error":"poll_error"}')
    }

    Start-Sleep -Milliseconds 400
}
