using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PdfAndMoore.Services;

/// <summary>
/// Talks to the Claude API (Anthropic Messages API) and streams the reply back piece by piece.
/// Docs: https://docs.claude.com/en/api/messages
/// </summary>
public sealed class ClaudeClient
{
    private const string Endpoint = "https://api.anthropic.com/v1/messages";
    private const string ApiVersion = "2023-06-01";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(5) };

    /// <summary>
    /// Sends a Messages API request body (JSON from the editor) and calls <paramref name="onText"/>
    /// for each chunk of text as it arrives. Returns the complete reply.
    /// </summary>
    public async Task<string> StreamAsync(string requestJson, string apiKey, Action<string> onText)
    {
        JsonNode body = JsonNode.Parse(requestJson) ?? new JsonObject();
        body["stream"] = true;

        using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("x-api-key", apiKey);
        request.Headers.Add("anthropic-version", ApiVersion);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));

        using HttpResponseMessage response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode)
        {
            string errorBody = await response.Content.ReadAsStringAsync();
            throw new InvalidOperationException($"{(int)response.StatusCode}: {ReadErrorMessage(errorBody)}");
        }

        var full = new StringBuilder();
        await using Stream stream = await response.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(stream, Encoding.UTF8);

        // Server-sent events: lines like "event: content_block_delta" and "data: {...}".
        while (await reader.ReadLineAsync() is { } line)
        {
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
            string json = line.Substring(5).Trim();
            if (json.Length == 0) continue;

            using JsonDocument evt = JsonDocument.Parse(json);
            JsonElement root = evt.RootElement;
            string type = root.TryGetProperty("type", out var t) ? t.GetString() ?? "" : "";

            if (type == "content_block_delta"
                && root.TryGetProperty("delta", out var delta)
                && delta.TryGetProperty("type", out var dt) && dt.GetString() == "text_delta")
            {
                string text = delta.GetProperty("text").GetString() ?? "";
                full.Append(text);
                onText(text);
            }
            else if (type == "error")
            {
                string message = root.TryGetProperty("error", out var err) && err.TryGetProperty("message", out var m)
                    ? m.GetString() ?? "Unknown error"
                    : "Unknown error";
                throw new InvalidOperationException(message);
            }
            else if (type == "message_stop")
            {
                break;
            }
        }
        return full.ToString();
    }

    private static string ReadErrorMessage(string body)
    {
        try
        {
            using JsonDocument doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("error", out var err) && err.TryGetProperty("message", out var m))
                return m.GetString() ?? body;
        }
        catch (JsonException)
        {
        }
        return body.Length > 300 ? body[..300] : body;
    }
}
