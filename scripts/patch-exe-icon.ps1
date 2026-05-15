#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$IconPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ExePath)) { throw "EXE not found: $ExePath" }
if (-not (Test-Path -LiteralPath $IconPath)) { throw "ICO not found: $IconPath" }

$source = @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class DeepCodexIconPatcher {
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    private static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);

    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, int cbData);

    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);

    private static readonly IntPtr RT_ICON = new IntPtr(3);
    private static readonly IntPtr RT_GROUP_ICON = new IntPtr(14);
    private static readonly IntPtr MAIN_ICON_GROUP = new IntPtr(1);
    private static readonly IntPtr APP_ICON_GROUP = new IntPtr(32512);

    private static ushort ReadUInt16(byte[] data, int offset) {
        return BitConverter.ToUInt16(data, offset);
    }

    private static uint ReadUInt32(byte[] data, int offset) {
        return BitConverter.ToUInt32(data, offset);
    }

    private static void WriteUInt16(MemoryStream stream, ushort value) {
        var bytes = BitConverter.GetBytes(value);
        stream.Write(bytes, 0, bytes.Length);
    }

    private static void WriteUInt32(MemoryStream stream, uint value) {
        var bytes = BitConverter.GetBytes(value);
        stream.Write(bytes, 0, bytes.Length);
    }

    public static void Patch(string exePath, string iconPath) {
        byte[] ico = File.ReadAllBytes(iconPath);
        if (ico.Length < 6) throw new InvalidDataException("ICO file is too small.");
        ushort reserved = ReadUInt16(ico, 0);
        ushort type = ReadUInt16(ico, 2);
        ushort count = ReadUInt16(ico, 4);
        if (reserved != 0 || type != 1 || count == 0) throw new InvalidDataException("Unsupported ICO file.");

        IntPtr handle = BeginUpdateResource(exePath, false);
        if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

        bool committed = false;
        try {
            using (var group = new MemoryStream()) {
                WriteUInt16(group, 0);
                WriteUInt16(group, 1);
                WriteUInt16(group, count);

                for (ushort i = 0; i < count; i++) {
                    int entry = 6 + (i * 16);
                    if (entry + 16 > ico.Length) throw new InvalidDataException("ICO entry is truncated.");
                    byte width = ico[entry + 0];
                    byte height = ico[entry + 1];
                    byte colorCount = ico[entry + 2];
                    byte reservedByte = ico[entry + 3];
                    ushort planes = ReadUInt16(ico, entry + 4);
                    ushort bitCount = ReadUInt16(ico, entry + 6);
                    uint bytesInRes = ReadUInt32(ico, entry + 8);
                    uint imageOffset = ReadUInt32(ico, entry + 12);
                    if (imageOffset + bytesInRes > ico.Length) throw new InvalidDataException("ICO image data is truncated.");

                    ushort resourceId = (ushort)(i + 1);
                    byte[] image = new byte[bytesInRes];
                    Buffer.BlockCopy(ico, (int)imageOffset, image, 0, (int)bytesInRes);
                    if (!UpdateResource(handle, RT_ICON, new IntPtr(resourceId), 0, image, image.Length)) {
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                    }

                    group.WriteByte(width);
                    group.WriteByte(height);
                    group.WriteByte(colorCount);
                    group.WriteByte(reservedByte);
                    WriteUInt16(group, planes);
                    WriteUInt16(group, bitCount);
                    WriteUInt32(group, bytesInRes);
                    WriteUInt16(group, resourceId);
                }

                byte[] groupData = group.ToArray();
                if (!UpdateResource(handle, RT_GROUP_ICON, MAIN_ICON_GROUP, 0, groupData, groupData.Length)) {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                if (!UpdateResource(handle, RT_GROUP_ICON, APP_ICON_GROUP, 0, groupData, groupData.Length)) {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
            }

            if (!EndUpdateResource(handle, false)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            committed = true;
        } finally {
            if (!committed) EndUpdateResource(handle, true);
        }
    }
}
"@

if (-not ("DeepCodexIconPatcher" -as [type])) {
    Add-Type -TypeDefinition $source -Language CSharp
}

[DeepCodexIconPatcher]::Patch((Resolve-Path -LiteralPath $ExePath).Path, (Resolve-Path -LiteralPath $IconPath).Path)
Write-Host "Patched icon: $ExePath"
