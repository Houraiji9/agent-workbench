param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Extended-Path([string]$Value) {
  if($Value.StartsWith('\\')){return '\\?\UNC\'+$Value.Substring(2)}
  return '\\?\'+$Value
}
if(Test-Path -LiteralPath $Destination){throw 'Extraction destination already exists'}
$dest=[IO.Path]::GetFullPath($Destination)
$zip=[IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $seen=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $total=[long]0
  if($zip.Entries.Count -gt 60000){throw 'Too many entries'}
  # Validate every entry before writing anything. No absolute paths, ADS, links or Windows aliases.
  foreach($entry in $zip.Entries){
    $name=$entry.FullName
    $parts=$name.TrimEnd('/').Split('/')
    if($name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or $parts[0] -cne 'AgentWorkbench'){throw 'Invalid archive root'}
    foreach($part in $parts){if(!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$|[\x00-\x1f<>"|?*]' -or $part -match '^(?i:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)'){throw 'Unsafe archive path'}}
    $type=($entry.ExternalAttributes -shr 16) -band 61440
    if(($type -ne 0 -and $type -ne 32768 -and $type -ne 16384) -or ($entry.ExternalAttributes -band 1024)){throw 'Archive links are not allowed'}
    if(!$seen.Add($name.TrimEnd('/'))){throw 'Duplicate archive entry'}
    $total+=$entry.Length
    if($entry.Length -gt 1073741824 -or $total -gt 3221225472){throw 'Archive too large'}
    $target=[IO.Path]::GetFullPath([IO.Path]::Combine($dest,$name.Replace('/',[IO.Path]::DirectorySeparatorChar)))
    if(!$target.StartsWith($dest+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Archive path outside destination'}
  }
  [IO.Directory]::CreateDirectory((Extended-Path $dest)) | Out-Null
  foreach($entry in $zip.Entries){
    $target=Extended-Path ([IO.Path]::Combine($dest,$entry.FullName.Replace('/',[IO.Path]::DirectorySeparatorChar)))
    if($entry.FullName.EndsWith('/')){[IO.Directory]::CreateDirectory($target)|Out-Null;continue}
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
    $inputStream=$entry.Open()
    try{$outputStream=[IO.File]::Open($target,[IO.FileMode]::CreateNew);try{$inputStream.CopyTo($outputStream)}finally{$outputStream.Dispose()}}finally{$inputStream.Dispose()}
  }
} finally {$zip.Dispose()}
