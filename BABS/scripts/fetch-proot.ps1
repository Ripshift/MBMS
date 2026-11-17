# Downloads Termux's proot build for arm64 and x86_64 and puts it in app/src/main/jniLibs.
#
# Android only lets apps run files from their native library folder, and only files named lib*.so are put there,
# so each file is renamed:
#
#   usr/bin/proot                 -> libproot.so
#   usr/libexec/proot/loader      -> libproot-loader.so
#   usr/lib/libtalloc.so.2        -> libtalloc.so
#   usr/lib/libandroid-shmem.so   -> libandroid-shmem.so
#
# proot asks for "libtalloc.so.2", which Android won't extract, so that name is patched to "libtalloc.so"
# in proot (and in libtalloc's own SONAME). The shorter name fits in the old one's space.
#
# Versions and SHA256s are pinned. To update, take new ones from
# https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-<arch>/Packages
#
# proot is GPL-2.0, libtalloc is LGPL-3.0, libandroid-shmem is BSD-3-Clause.

$ErrorActionPreference = 'Stop'
$repo = 'https://packages.termux.dev/apt/termux-main'
$jniLibs = Join-Path $PSScriptRoot '..\app\src\main\jniLibs' | Resolve-Path -ErrorAction SilentlyContinue
if (-not $jniLibs) { $jniLibs = New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot '..\app\src\main\jniLibs') }

$packages = @{
    'arm64-v8a' = @(
        @{ File = 'pool/main/p/proot/proot_5.1.107.102_aarch64.deb'; Sha = '10a394b585c2fc2b2c8502544f4e5f1be581dc8bfff79e8ba62f16207423e030' }
        @{ File = 'pool/main/libt/libtalloc/libtalloc_2.5.0_aarch64.deb'; Sha = '556591f43bb773ad8777e1a29522640866a55f95dab71914418b94a8c58ad5a7' }
        @{ File = 'pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_aarch64.deb'; Sha = '0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6' }
    )
    'x86_64' = @(
        @{ File = 'pool/main/p/proot/proot_5.1.107.102_x86_64.deb'; Sha = '2497064226c15971be8131c7facead94a06c225347796326a383c832dca57758' }
        @{ File = 'pool/main/libt/libtalloc/libtalloc_2.5.0_x86_64.deb'; Sha = 'b8c6d95f20075dc1f9ec6573575b2444e8d526e48e0d8d6d5cf4e071e6e06530' }
        @{ File = 'pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_x86_64.deb'; Sha = 'ffa9e4c87467b158b148d0ff92dda796aa038276c2075af3269cdcdb06f25797' }
    )
}

# Replaces a null-terminated string in an ELF file with a shorter one, padding with nulls.
function Set-ElfString([string]$path, [string]$from, [string]$to) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $find = [Text.Encoding]::ASCII.GetBytes($from + "`0")
    $replace = [Text.Encoding]::ASCII.GetBytes($to) + (New-Object byte[] ($find.Length - $to.Length))
    $count = 0
    for ($i = 0; $i -le $bytes.Length - $find.Length; $i++) {
        $match = $true
        for ($j = 0; $j -lt $find.Length; $j++) { if ($bytes[$i + $j] -ne $find[$j]) { $match = $false; break } }
        # Only whole strings: the byte before must end the previous string.
        if ($match -and ($i -eq 0 -or $bytes[$i - 1] -eq 0)) {
            [Array]::Copy($replace, 0, $bytes, $i, $replace.Length)
            $count++
        }
    }
    if ($count -eq 0) { throw "'$from' not found in $path" }
    [IO.File]::WriteAllBytes($path, $bytes)
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("babs-proot-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $work | Out-Null
try {
    foreach ($abi in $packages.Keys) {
        $root = Join-Path $work $abi
        New-Item -ItemType Directory $root | Out-Null
        foreach ($p in $packages[$abi]) {
            $deb = Join-Path $work ([IO.Path]::GetFileName($p.File))
            Write-Host "Downloading $($p.File)"
            Invoke-WebRequest -UseBasicParsing "$repo/$($p.File)" -OutFile $deb
            $sha = (Get-FileHash $deb -Algorithm SHA256).Hash.ToLower()
            if ($sha -ne $p.Sha) { throw "SHA256 mismatch for $($p.File): got $sha" }

            # A .deb is an ar archive holding data.tar.xz. Windows' tar (libarchive) reads both.
            $unpack = Join-Path $work ([IO.Path]::GetFileNameWithoutExtension($deb))
            New-Item -ItemType Directory $unpack | Out-Null
            tar -xf $deb -C $unpack
            if ($LASTEXITCODE -ne 0) { throw "Couldn't unpack $deb" }
            $data = Get-ChildItem $unpack -Filter 'data.tar.*' | Select-Object -First 1
            tar -xf $data.FullName -C $root
            if ($LASTEXITCODE -ne 0) { throw "Couldn't unpack $($data.Name)" }
        }

        $usr = Join-Path $root 'data\data\com.termux\files\usr'
        $out = Join-Path $jniLibs $abi
        New-Item -ItemType Directory -Force $out | Out-Null

        # libtalloc.so.2 may be a symlink to libtalloc.so.2.x.y. Take the real file.
        $talloc = Get-ChildItem (Join-Path $usr 'lib') -Filter 'libtalloc.so.2*' |
            Where-Object { -not $_.LinkType -and $_.Length -gt 1000 } | Select-Object -First 1

        Copy-Item (Join-Path $usr 'bin\proot') (Join-Path $out 'libproot.so') -Force
        Copy-Item (Join-Path $usr 'libexec\proot\loader') (Join-Path $out 'libproot-loader.so') -Force
        Copy-Item $talloc.FullName (Join-Path $out 'libtalloc.so') -Force
        Copy-Item (Join-Path $usr 'lib\libandroid-shmem.so') (Join-Path $out 'libandroid-shmem.so') -Force

        Set-ElfString (Join-Path $out 'libproot.so') 'libtalloc.so.2' 'libtalloc.so'
        Set-ElfString (Join-Path $out 'libtalloc.so') 'libtalloc.so.2' 'libtalloc.so'

        Write-Host "${abi}:"
        Get-ChildItem $out | ForEach-Object { Write-Host ("  {0,-22} {1,8:N0} bytes" -f $_.Name, $_.Length) }
    }
}
finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
