using System.Windows;
using System.Windows.Media.Imaging;

namespace PdfAndMoore.Services;

/// <summary>Copies text or a PNG picture to the Windows clipboard (for pasting into Claude).</summary>
public static class ClipboardHelper
{
    public static void SetText(string text)
    {
        // The clipboard is sometimes busy for a moment (another app reading it), so retry briefly.
        for (int attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                Clipboard.SetText(text);
                return;
            }
            catch (System.Runtime.InteropServices.COMException)
            {
                Thread.Sleep(60);
            }
        }
    }

    public static void SetPng(byte[] png)
    {
        using var stream = new MemoryStream(png);
        var decoder = new PngBitmapDecoder(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
        BitmapSource frame = decoder.Frames[0];
        for (int attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                Clipboard.SetImage(frame);
                return;
            }
            catch (System.Runtime.InteropServices.COMException)
            {
                Thread.Sleep(60);
            }
        }
    }
}
