# Generates the "Fresh Survey" tile overlay (tiles/nc/) from local JourneyMap data.
#
# JourneyMap region files are 512x512 px covering 512x512 blocks (1px/block), named
# <regionX>,<regionZ>.png. Site tiles are 256x256 px: z0 = 1px/block, each level
# down halves the scale — same scheme as the CivMC community tiles the map already uses.
#
# To update the map: walk around in-game with JourneyMap running, then
#   powershell -File tools\generate-nc-tiles.ps1
# and commit the regenerated tiles/nc/ folder. Includes every surveyed region
# (used by both the NC registry map and the terminal world map overlays).

param(
    [string]$JmDay = "$env:APPDATA\.minecraft\journeymap\data\mp\civmc\overworld\day",
    [string]$OutDir = (Join-Path $PSScriptRoot '..\tiles\nc'),
    # 512-block region coords to include (default: everything surveyed)
    [int]$RegionMinX = -100, [int]$RegionMaxX = 100,
    [int]$RegionMinZ = -100, [int]$RegionMaxZ = 100,
    [int]$MinZoom = -3
)

Add-Type -AssemblyName System.Drawing
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
if (-not (Test-Path $JmDay)) { throw "JourneyMap day folder not found: $JmDay" }

# --- z0: split each 512px JourneyMap region into four 256-block tiles ---
$z0Dir = Join-Path $OutDir 'z0'
New-Item -ItemType Directory -Force $z0Dir | Out-Null
Get-ChildItem $z0Dir -File -ErrorAction SilentlyContinue | Remove-Item -Force
$z0Tiles = @{}
$regionCount = 0

foreach ($f in Get-ChildItem $JmDay -File -Filter '*.png') {
    if ($f.Name -notmatch '^(-?\d+),(-?\d+)\.png$') { continue }
    $rx = [int]$Matches[1]; $rz = [int]$Matches[2]
    if ($rx -lt $RegionMinX -or $rx -gt $RegionMaxX -or $rz -lt $RegionMinZ -or $rz -gt $RegionMaxZ) { continue }
    $regionCount++
    $src = [System.Drawing.Image]::FromFile($f.FullName)
    foreach ($i in 0, 1) {
        foreach ($j in 0, 1) {
            $tx = 2 * $rx + $i; $ty = 2 * $rz + $j
            $tile = New-Object System.Drawing.Bitmap(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $g = [System.Drawing.Graphics]::FromImage($tile)
            $g.DrawImage($src,
                (New-Object System.Drawing.Rectangle(0, 0, 256, 256)),
                (New-Object System.Drawing.Rectangle((256 * $i), (256 * $j), 256, 256)),
                [System.Drawing.GraphicsUnit]::Pixel)
            $g.Dispose()
            $tile.Save((Join-Path $z0Dir "$tx,$ty.png"), [System.Drawing.Imaging.ImageFormat]::Png)
            $tile.Dispose()
            $z0Tiles["$tx,$ty"] = $true
        }
    }
    $src.Dispose()
}
Write-Host "z0: $($z0Tiles.Count) tiles from $regionCount JourneyMap regions"

# --- z-1 .. MinZoom: each tile combines four children from the level above, downscaled 2x ---
$prevTiles = $z0Tiles
for ($z = -1; $z -ge $MinZoom; $z--) {
    $zDir = Join-Path $OutDir "z$z"
    New-Item -ItemType Directory -Force $zDir | Out-Null
    Get-ChildItem $zDir -File -ErrorAction SilentlyContinue | Remove-Item -Force
    $prevDir = Join-Path $OutDir "z$($z + 1)"
    $parents = @{}
    foreach ($key in $prevTiles.Keys) {
        $cx, $cy = $key -split ','
        $parents["$([Math]::Floor([int]$cx / 2)),$([Math]::Floor([int]$cy / 2))"] = $true
    }
    foreach ($pkey in $parents.Keys) {
        $px, $py = ($pkey -split ',') | ForEach-Object { [int]$_ }
        $canvas = New-Object System.Drawing.Bitmap(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($canvas)
        foreach ($i in 0, 1) {
            foreach ($j in 0, 1) {
                $childFile = Join-Path $prevDir "$(2 * $px + $i),$(2 * $py + $j).png"
                if (Test-Path $childFile) {
                    $child = [System.Drawing.Image]::FromFile($childFile)
                    $g.DrawImage($child, (256 * $i), (256 * $j), 256, 256)
                    $child.Dispose()
                }
            }
        }
        $g.Dispose()
        $out = New-Object System.Drawing.Bitmap(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g2 = [System.Drawing.Graphics]::FromImage($out)
        $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g2.DrawImage($canvas, 0, 0, 256, 256)
        $g2.Dispose()
        $canvas.Dispose()
        $out.Save((Join-Path $zDir "$pkey.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $out.Dispose()
    }
    Write-Host "z$($z): $($parents.Count) tiles"
    $prevTiles = $parents
}

$total = (Get-ChildItem $OutDir -Recurse -File | Measure-Object -Property Length -Sum)
Write-Host ("Done: {0} files, {1:N1} MB in {2}" -f $total.Count, ($total.Sum / 1MB), $OutDir)
