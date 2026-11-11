namespace PdfAndMoore.Services;

/// <summary>
/// Which built-in editor opens a file: "word" (documents), "sheet" (spreadsheets) or "slides" (presentations).
/// Other files (PDF, pictures, old .doc/.ppt, RTF, ODT...) open in the PDF editor as before.
/// </summary>
public static class OfficeTypes
{
    private static readonly Dictionary<string, string> Editors = new(StringComparer.OrdinalIgnoreCase)
    {
        ["docx"] = "word",
        ["docm"] = "word",
        ["dotx"] = "word",
        ["xlsx"] = "sheet",
        ["xlsm"] = "sheet",
        ["xls"] = "sheet",
        ["xlsb"] = "sheet",
        ["csv"] = "sheet",
        ["tsv"] = "sheet",
        ["ods"] = "sheet",
        ["pptx"] = "slides",
        ["pptm"] = "slides",
        ["ppsx"] = "slides",
    };

    private static string ExtOf(string path) => Path.GetExtension(path).TrimStart('.');

    /// <summary>"word", "sheet", "slides", or null when the file belongs in the PDF editor.</summary>
    public static string? EditorFor(string path) => Editors.TryGetValue(ExtOf(path), out var kind) ? kind : null;

    public static bool IsKind(string? kind) => kind is "word" or "sheet" or "slides";

    public static string Label(string kind) => kind switch
    {
        "word" => "document",
        "sheet" => "spreadsheet",
        _ => "presentation",
    };

    /// <summary>File-dialog filter for files the built-in editors open.</summary>
    public const string OpenFilter =
        "Word, Excel and PowerPoint files|*.docx;*.docm;*.dotx;*.xlsx;*.xlsm;*.xls;*.xlsb;*.csv;*.tsv;*.ods;*.pptx;*.pptm;*.ppsx|" +
        "Word documents (*.docx)|*.docx;*.docm;*.dotx|" +
        "Excel workbooks (*.xlsx, *.xls, *.csv)|*.xlsx;*.xlsm;*.xls;*.xlsb;*.csv;*.tsv;*.ods|" +
        "PowerPoint presentations (*.pptx)|*.pptx;*.pptm;*.ppsx|" +
        "All files (*.*)|*.*";

    public static string SaveFilterFor(string ext) => ext.ToLowerInvariant() switch
    {
        "docx" => "Word document (*.docx)|*.docx",
        "xlsx" => "Excel workbook (*.xlsx)|*.xlsx",
        "csv" => "CSV (comma separated) (*.csv)|*.csv",
        "pptx" => "PowerPoint presentation (*.pptx)|*.pptx",
        _ => "All files (*.*)|*.*",
    };
}
