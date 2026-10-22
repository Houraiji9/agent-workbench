param([Parameter(Mandatory=$true)][string]$FilePath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class WorkbenchFileLocation {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  static extern int SHParseDisplayName(string name, IntPtr bind, out IntPtr pidl, uint attrs, out uint resultAttrs);
  [DllImport("shell32.dll")]
  static extern IntPtr ILFindLastID(IntPtr pidl);
  [DllImport("shell32.dll")]
  static extern int SHOpenFolderAndSelectItems(IntPtr folder, uint count, [In, MarshalAs(UnmanagedType.LPArray)] IntPtr[] items, uint flags);
  public static void Show(string file) {
    if (!File.Exists(file)) throw new FileNotFoundException();
    IntPtr folderId=IntPtr.Zero, fileId=IntPtr.Zero;
    uint attrs;
    try {
      Marshal.ThrowExceptionForHR(SHParseDisplayName(Path.GetDirectoryName(file), IntPtr.Zero, out folderId, 0, out attrs));
      Marshal.ThrowExceptionForHR(SHParseDisplayName(file, IntPtr.Zero, out fileId, 0, out attrs));
      Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(folderId, 1, new IntPtr[]{ILFindLastID(fileId)}, 0));
    } finally {
      if (fileId!=IntPtr.Zero) Marshal.FreeCoTaskMem(fileId);
      if (folderId!=IntPtr.Zero) Marshal.FreeCoTaskMem(folderId);
    }
  }
}
'@
[WorkbenchFileLocation]::Show($FilePath)
