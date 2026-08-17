# 桌面应用图标生成脚本（PowerShell 内嵌 C# + .NET System.Drawing）
# 功能：读取透明背景的鲸鱼 PNG，合成透明圆角 + 白色圆角矩形底，缩放到多尺寸，输出标准 ICO 文件
# 用法：powershell -ExecutionPolicy Bypass -File scripts\png-to-ico.ps1

param(
    [string]$SourcePng = "C:\Users\11012\Desktop\deepseek.png",
    [string]$OutputIco = "build\icon.ico"
)

Add-Type -AssemblyName System.Drawing

# 内嵌 C# 代码：处理 PNG → 透明圆角白底合成 → 多尺寸缩放 → ICO 文件写出
$refs = @(
    "System.dll",
    "System.Drawing.dll",
    "System.Windows.Forms.dll"
)
Add-Type -ReferencedAssemblies $refs -TypeDefinition @"
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

public static class IconBuilder
{
    private static readonly int[] Sizes = new int[] { 16, 32, 48, 64, 128, 256 };
    private const float CornerRadiusRatio = 0.225f;

    private static GraphicsPath RoundedRectPath(int x, int y, int w, int h, float radius)
    {
        GraphicsPath path = new GraphicsPath();
        float r = Math.Min(radius, Math.Min(w, h) * 0.5f);
        if (r <= 0f)
        {
            path.AddRectangle(new Rectangle(x, y, w, h));
            return path;
        }
        path.AddArc(x, y, r * 2, r * 2, 180f, 90f);
        path.AddLine(x + r, y, x + w - r, y);
        path.AddArc(x + w - r * 2, y, r * 2, r * 2, 270f, 90f);
        path.AddLine(x + w, y + r, x + w, y + h - r);
        path.AddArc(x + w - r * 2, y + h - r * 2, r * 2, r * 2, 0f, 90f);
        path.AddLine(x + w - r, y + h, x + r, y + h);
        path.AddArc(x, y + h - r * 2, r * 2, r * 2, 90f, 90f);
        path.AddLine(x, y + h - r, x, y + r);
        path.CloseFigure();
        return path;
    }

    public static void Build(string sourcePngPath, string outputIcoPath)
    {
        using (Bitmap src = (Bitmap)Bitmap.FromFile(sourcePngPath))
        {
            int sq = Math.Max(src.Width, src.Height);
            using (Bitmap square = new Bitmap(sq, sq, PixelFormat.Format32bppArgb))
            using (Graphics g = Graphics.FromImage(square))
            using (Brush whiteBrush = new SolidBrush(Color.White))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.FromArgb(0, 255, 255, 255));
                float radius = sq * CornerRadiusRatio;
                using (GraphicsPath path = RoundedRectPath(0, 0, sq, sq, radius))
                {
                    g.FillPath(whiteBrush, path);
                }
                // Shrink whale to 81% (90% × 0.9) for more padding
                int drawW = (int)(src.Width * 0.81);
                int drawH = (int)(src.Height * 0.81);
                int ox = (sq - drawW) / 2;
                int oy = (sq - drawH) / 2;
                g.DrawImage(src, ox, oy, drawW, drawH);

                byte[][] pixelBuffers = new byte[Sizes.Length][];
                for (int i = 0; i < Sizes.Length; i++)
                {
                    int sz = Sizes[i];
                    using (Bitmap resized = new Bitmap(sz, sz, PixelFormat.Format32bppArgb))
                    using (Graphics g2 = Graphics.FromImage(resized))
                    using (Brush wb = new SolidBrush(Color.White))
                    {
                        g2.SmoothingMode = SmoothingMode.AntiAlias;
                        g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g2.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g2.CompositingQuality = CompositingQuality.HighQuality;
                        g2.Clear(Color.FromArgb(0, 255, 255, 255));
                        float r2 = sz * CornerRadiusRatio;
                        using (GraphicsPath path2 = RoundedRectPath(0, 0, sz, sz, r2))
                        {
                            g2.FillPath(wb, path2);
                        }
                        g2.DrawImage(square, 0, 0, sz, sz);

                        Rectangle rect = new Rectangle(0, 0, sz, sz);
                        BitmapData bd = resized.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                        int byteCount = sz * sz * 4;
                        byte[] raw = new byte[byteCount];
                        Marshal.Copy(bd.Scan0, raw, 0, byteCount);
                        resized.UnlockBits(bd);

                        byte[] bgra = new byte[byteCount];
                        for (int y = 0; y < sz; y++)
                        {
                            int srcRow = (sz - 1 - y) * sz * 4;
                            int dstRow = y * sz * 4;
                            Buffer.BlockCopy(raw, srcRow, bgra, dstRow, sz * 4);
                        }
                        pixelBuffers[i] = bgra;
                    }
                }

                string dir = Path.GetDirectoryName(outputIcoPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                    Directory.CreateDirectory(dir);

                using (FileStream fs = new FileStream(outputIcoPath, FileMode.Create))
                using (BinaryWriter bw = new BinaryWriter(fs))
                {
                    bw.Write((ushort)0);
                    bw.Write((ushort)1);
                    bw.Write((ushort)Sizes.Length);

                    int[] offsets = new int[Sizes.Length];
                    int[] dataSizes = new int[Sizes.Length];
                    int cursor = 6 + 16 * Sizes.Length;
                    for (int i = 0; i < Sizes.Length; i++)
                    {
                        int pixelSize = Sizes[i] * Sizes[i] * 4;
                        int imageSize = 40 + pixelSize;
                        offsets[i] = cursor;
                        dataSizes[i] = imageSize;
                        cursor += imageSize;
                    }

                    for (int i = 0; i < Sizes.Length; i++)
                    {
                        int sz = Sizes[i];
                        bw.Write((byte)(sz == 256 ? 0 : sz));
                        bw.Write((byte)(sz == 256 ? 0 : sz));
                        bw.Write((byte)0);
                        bw.Write((byte)0);
                        bw.Write((ushort)1);
                        bw.Write((ushort)32);
                        bw.Write((uint)dataSizes[i]);
                        bw.Write((uint)offsets[i]);
                    }

                    for (int i = 0; i < Sizes.Length; i++)
                    {
                        int sz = Sizes[i];
                        int pixelSize = sz * sz * 4;
                        bw.Write((uint)40);
                        bw.Write((int)sz);
                        bw.Write((int)(sz * 2));
                        bw.Write((ushort)1);
                        bw.Write((ushort)32);
                        bw.Write((uint)0);
                        bw.Write((uint)pixelSize);
                        bw.Write((int)0);
                        bw.Write((int)0);
                        bw.Write((uint)0);
                        bw.Write((uint)0);
                        bw.Write(pixelBuffers[i]);
                    }

                    bw.Flush();
                }
            }
        }
    }
}
"@

$OutputIcoAbs = Join-Path (Get-Location) $OutputIco

Write-Host "================================================"  -ForegroundColor Cyan
Write-Host "  DSH Desktop 圆角图标生成" -ForegroundColor Cyan
Write-Host "  源文件: $SourcePng" -ForegroundColor Gray
Write-Host "  输出:   $OutputIcoAbs" -ForegroundColor Gray
Write-Host "  圆角比例: 22.5% (Windows 11 风格)" -ForegroundColor Gray
Write-Host "================================================"  -ForegroundColor Cyan

Write-Host "[1/2] 合成透明圆角白底、多尺寸缩放、写出 ICO..." -ForegroundColor Yellow
[IconBuilder]::Build($SourcePng, $OutputIcoAbs)

Write-Host "[2/2] 验证 ICO 文件头..." -ForegroundColor Yellow
$written = [System.IO.File]::ReadAllBytes($OutputIcoAbs)
$valid = $true
if ($written.Length -lt 6) {
    Write-Host "      [FAIL] 文件过小" -ForegroundColor Red
    $valid = $false
} else {
    $type = [BitConverter]::ToUInt16($written, 2)
    $count = [BitConverter]::ToUInt16($written, 4)
    if ($type -ne 1) {
        Write-Host "      [FAIL] ICO type 字段错误: $type (期望 1)" -ForegroundColor Red
        $valid = $false
    }
    if ($count -ne 6) {
        Write-Host "      [FAIL] ICO image count 错误: $count (期望 6)" -ForegroundColor Red
        $valid = $false
    }
}

if ($valid) {
    Write-Host "      [PASS] ICO 文件头校验通过 (6 个尺寸: 16,32,48,64,128,256)" -ForegroundColor Green
    $fi = Get-Item $OutputIcoAbs
    $kb = [Math]::Round($fi.Length / 1KB, 2)
    Write-Host "================================================"  -ForegroundColor Cyan
    Write-Host "  完成! 输出文件: $OutputIcoAbs" -ForegroundColor Green
    Write-Host "  文件大小: $($fi.Length) bytes ($kb KB)" -ForegroundColor Green
    Write-Host "================================================"  -ForegroundColor Cyan
} else {
    throw "生成的 ICO 文件校验失败"
}
