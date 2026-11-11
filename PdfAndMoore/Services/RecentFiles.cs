using System.Text.Json;

namespace PdfAndMoore.Services;

/// <summary>Remembers the last PDFs you opened or saved (%APPDATA%\PdfAndMoore\recent.json).</summary>
public sealed class RecentFiles
{
    private const int MaxItems = 12;

    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PdfAndMoore", "recent.json");

    public List<string> Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return new List<string>();
            var list = JsonSerializer.Deserialize<List<string>>(File.ReadAllText(FilePath)) ?? new List<string>();
            return list.Where(File.Exists).ToList();
        }
        catch (Exception)
        {
            return new List<string>();
        }
    }

    public void Add(string path)
    {
        try
        {
            var list = Load();
            list.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
            list.Insert(0, path);
            if (list.Count > MaxItems) list.RemoveRange(MaxItems, list.Count - MaxItems);
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(list));
        }
        catch (Exception)
        {
            // Not being able to update the recent list is not worth interrupting the user.
        }
    }
}
