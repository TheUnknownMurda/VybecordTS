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
#   8. Thumbnail extracted once per track, not on every full-refresh tick
#
# Robustness:
#   - Every WinRT await is bounded; a suspended app can never freeze the reader.
#   - The session manager is re-acquired after repeated failures (SMTC service restart).
#   - Transient errors emit {"error":...} without "is_playing", so the Node side
#     keeps the last known state instead of dropping the presence on one hiccup.

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

# Bounded await. A WinRT operation on a suspended UWP app or a zombie session can
# never complete, and Wait(-1) would freeze the reader permanently. Returns $null
# on timeout so callers can keep their cached state and retry on the next tick.
Function AwaitFast($WinRtTask, $precompiledMethod, $timeoutMs = 3000) {
    $netTask = $precompiledMethod.Invoke($null, @($WinRtTask))
    if ($netTask.Wait($timeoutMs)) { return $netTask.Result }
    return $null
}

# ── Session manager (re-acquired by the poll loop if it goes stale) ──
function New-SessionManager {
    return AwaitFast ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) $asTaskManager 5000
}

$mgr = New-SessionManager

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

# JSON escape: handle ", \, and control characters in track/artist/album strings.
# The backslash pass must run first so the escapes inserted below aren't doubled.
# Any OTHER control char (U+0000-U+001F, e.g. \b or \f from a malformed ID3 tag)
# is stripped: left raw it produces invalid JSON, and the Node side then drops
# the whole line while logging only 1 parse error in 100 — a silent stall.
function JsonEsc([string]$s) {
    if ($null -eq $s) { return '' }
    $e = $s.Replace('\', '\\').Replace('"', '\"').Replace("`n", '\n').Replace("`r", '\r').Replace("`t", '\t')
    return [regex]::Replace($e, '[\x00-\x1F]', '')
}

# Signal ready
[Console]::WriteLine('{"ready":true}')

# ── State caches ──
$thumbPath = Join-Path $env:TEMP 'vybecord_thumb.jpg'
$lastThumbTitle = ''        # Title we last wrote the thumbnail for
$thumbAvailable = $false    # Whether the current track has usable art on disk
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
$consecutiveErrors = 0
$MAX_ERRORS_BEFORE_RESET = 5    # Drop the session manager after this many failed ticks

# ── Poll loop ──
while ($true) {
    try {
        $pollCount++
        $bestSession = $null
        $bestSource = 'unknown'

        # ── Manager health: re-acquire a fresh one after repeated failures ──
        if ($null -eq $mgr) {
            $mgr = New-SessionManager
            if ($null -eq $mgr) {
                [Console]::WriteLine('{"error":"no_session_manager"}')
                Start-Sleep -Milliseconds 2000
                continue
            }
            $cachedSession = $null
            $cachedSourceId = ''
        }

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
            # A stale manager returns $null instead of throwing — that must not be
            # mistaken for "nothing is playing", or the presence drops forever.
            if ($null -eq $sessions) {
                $consecutiveErrors++
                if ($consecutiveErrors -ge $MAX_ERRORS_BEFORE_RESET) {
                    $mgr = $null
                    $consecutiveErrors = 0
                }
                [Console]::WriteLine('{"error":"no_sessions"}')
                Start-Sleep -Milliseconds 400
                continue
            }
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
            $info = $null
            if ($trackChanged) {
                $info = AwaitFast ($bestSession.TryGetMediaPropertiesAsync()) $asTaskMedia
                # Timed out: keep the cached metadata and leave the change flags
                # untouched so the next tick retries instead of latching bad data.
                if ($null -eq $info) { $trackChanged = $false }
            }

            if ($trackChanged) {
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

                # ── Thumbnail ──
                # $trackChanged is also true on every FULL_REFRESH_EVERY tick, where the
                # track is unchanged. Re-reading the WinRT stream and rewriting a 100-500 KB
                # JPEG every 4s is pure disk churn, so extract only when the title actually
                # differs from the one we last wrote (or the file went missing).
                $thumbFileExists = Test-Path $thumbPath
                if ($cachedTitle -eq $lastThumbTitle -and $thumbFileExists) {
                    $thumbAvailable = $true
                } else {
                    $thumbAvailable = $false
                    # Don't overwrite an existing file when SMTC has no thumbnail —
                    # it likely holds art extracted by local-art.ts.
                    try {
                        $thumbRef = $info.Thumbnail
                        if ($null -ne $thumbRef) {
                            $stream = $null
                            $reader = $null
                            try {
                                $stream = AwaitFast ($thumbRef.OpenReadAsync()) $asTaskStream 2000
                                if ($null -ne $stream) {
                                    $sz = [uint32]$stream.Size
                                    if ($sz -gt 0 -and $sz -lt 5000000) {
                                        $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
                                        $loaded = AwaitFast ($reader.LoadAsync($sz)) $asTaskUInt32 2000
                                        if ($null -ne $loaded) {
                                            $buf = [byte[]]::new($sz)
                                            $reader.ReadBytes($buf)
                                            [System.IO.File]::WriteAllBytes($thumbPath, $buf)
                                            $lastThumbTitle = $cachedTitle
                                            $thumbAvailable = $true
                                        }
                                    }
                                }
                            } finally {
                                if ($null -ne $reader) { try { $reader.Dispose() } catch {} }
                                if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
                            }
                        }
                        # SMTC gave us nothing but a file exists (local-art.ts) — use it.
                        # $lastThumbTitle stays put so a late-arriving SMTC thumbnail
                        # (common for browser sessions) is still picked up next tick.
                        if (-not $thumbAvailable -and $thumbFileExists) { $thumbAvailable = $true }
                    } catch {}
                }
                $thumbExtracted = $thumbAvailable
            } else {
                # Track didn't change — reuse the state computed on the last real change
                $thumbExtracted = $thumbAvailable
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
            $thumbAvailable = $false
            [Console]::WriteLine('{"is_playing":false}')
        }

        $consecutiveErrors = 0
    }
    catch {
        $consecutiveErrors++
        # The session manager can go stale (SMTC service restart, session switch) and
        # then throw on every call. Drop it so the next tick acquires a fresh one.
        if ($consecutiveErrors -ge $MAX_ERRORS_BEFORE_RESET) {
            $mgr = $null
            $cachedSession = $null
            $consecutiveErrors = 0
        }
        # No "is_playing" field on purpose: a transient WinRT error is not the same as
        # "nothing is playing". The Node side keeps the last known state and lets its
        # staleness watchdog decide, instead of killing the presence on one hiccup.
        [Console]::WriteLine('{"error":"poll_error"}')
    }

    Start-Sleep -Milliseconds 400
}
