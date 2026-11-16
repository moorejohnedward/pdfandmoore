namespace PdfAndMoore.Services;

/// <summary>
/// Which built-in editor opens a file: "word" (documents), "sheet" (spreadsheets), "slides" (presentations)
/// or "text" (plain text files: notes, .txt, .md, .json, scripts…, v9.7).
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
        ["txt"] = "text",
        ["text"] = "text",
        ["md"] = "text",
        ["log"] = "text",
        ["json"] = "text",
        ["xml"] = "text",
        ["ini"] = "text",
        ["cfg"] = "text",
        ["conf"] = "text",
        ["yaml"] = "text",
        ["yml"] = "text",
        ["bat"] = "text",
        ["cmd"] = "text",
        ["ps1"] = "text",
        ["reg"] = "text",
    };

    private static string ExtOf(string path) => Path.GetExtension(path).TrimStart('.');

    /// <summary>"word", "sheet", "slides", or null when the file belongs in the PDF editor.</summary>
    public static string? EditorFor(string path) => Editors.TryGetValue(ExtOf(path), out var kind) ? kind : null;

    public static bool IsKind(string? kind) => kind is "word" or "sheet" or "slides" or "text";

    public static string Label(string kind) => kind switch
    {
        "word" => "document",
        "sheet" => "spreadsheet",
        "text" => "text file",
        _ => "presentation",
    };

    /// <summary>File-dialog filter for files the built-in editors open.</summary>
    public const string OpenFilter =
        "Word, Excel, PowerPoint and text files|*.docx;*.docm;*.dotx;*.xlsx;*.xlsm;*.xls;*.xlsb;*.csv;*.tsv;*.ods;*.pptx;*.pptm;*.ppsx;*.txt;*.md;*.log;*.json;*.xml;*.ini;*.cfg;*.yaml;*.yml;*.bat;*.cmd;*.ps1|" +
        "Word documents (*.docx)|*.docx;*.docm;*.dotx|" +
        "Excel workbooks (*.xlsx, *.xls, *.csv)|*.xlsx;*.xlsm;*.xls;*.xlsb;*.csv;*.tsv;*.ods|" +
        "PowerPoint presentations (*.pptx)|*.pptx;*.pptm;*.ppsx|" +
        "Text files (*.txt, *.md, *.json…)|*.txt;*.md;*.log;*.json;*.xml;*.ini;*.cfg;*.yaml;*.yml;*.bat;*.cmd;*.ps1|" +
        "All files (*.*)|*.*";

    public static string SaveFilterFor(string ext) => ext.ToLowerInvariant() switch
    {
        "docx" => "Word document (*.docx)|*.docx",
        "xlsx" => "Excel workbook (*.xlsx)|*.xlsx",
        "csv" => "CSV (comma separated) (*.csv)|*.csv",
        "pptx" => "PowerPoint presentation (*.pptx)|*.pptx",
        // Text files can be saved under any name and extension (notes.txt, list.md, script.ps1…).
        "txt" => "Text file (*.txt)|*.txt|All files (*.*)|*.*",
        "md" => "Markdown (*.md)|*.md|Text file (*.txt)|*.txt|All files (*.*)|*.*",
        _ => "All files (*.*)|*.*",
    };
}
