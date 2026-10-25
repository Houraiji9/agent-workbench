param([ValidateSet('probe','move')][string]$Operation,[Parameter(Mandatory=$true)][string]$Source,[string]$Destination)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
function Assert-LocalPath([string]$Value,[bool]$AllowMissing) {
  if($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value.Substring(2).Contains(':') -or $Value -match '[\x00-\x1f]') { throw 'Only an absolute local file path is allowed.' }
  $full=[IO.Path]::GetFullPath($Value)
  $cursor=[IO.Path]::GetPathRoot($full)
  foreach($part in $full.Substring($cursor.Length).Split([char[]]@('\','/'),[StringSplitOptions]::RemoveEmptyEntries)) {
    $cursor=[IO.Path]::Combine($cursor,$part)
    try { $attributes=[IO.File]::GetAttributes($cursor) }
    catch [IO.FileNotFoundException] { if($AllowMissing) { continue }; throw }
    catch [IO.DirectoryNotFoundException] { if($AllowMissing) { continue }; throw }
    if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Links and redirected directories are not allowed.' }
  }
  return $full
}
try {
  $Source=Assert-LocalPath $Source $false
  if(([IO.File]::GetAttributes($Source) -band [IO.FileAttributes]::Directory) -ne 0) { throw 'A regular source file is required.' }
  if($Operation -eq 'probe') {
    $handle=[IO.File]::Open($Source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    $handle.Dispose()
    Write-Output 'available'
  } else {
    if([String]::IsNullOrWhiteSpace($Destination)) { throw 'Destination is required.' }
    $Destination=Assert-LocalPath $Destination $true
    if([IO.Path]::GetPathRoot($Source) -ne [IO.Path]::GetPathRoot($Destination)) { throw 'Cross-volume moves are not allowed.' }
    # The two-argument overload refuses an existing destination.
    [IO.File]::Move($Source,$Destination)
    Write-Output 'moved'
  }
} catch {
  $failure=$_.Exception
  while($failure.InnerException) { $failure=$failure.InnerException }
  if($Operation -eq 'probe' -and (($failure.HResult -band 0xffff) -in @(32,33))) { Write-Output 'busy'; exit 0 }
  [Console]::Error.WriteLine($failure.Message)
  exit 1
}
