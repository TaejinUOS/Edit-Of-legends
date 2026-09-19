using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;

internal static class EditOfLegendsLauncher
{
    private const string Scheme = "editoflegends";
    private const string EngineUrl = "http://localhost:4317/api/health";
    private static readonly Regex TokenPattern = new Regex(
        "^[a-f0-9]{64}$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    );

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string token = ReadToken(args);
            if (EngineIsReady(token))
            {
                return 0;
            }

            string installDirectory = AppDomain.CurrentDomain.BaseDirectory;
            string nodePath = Path.Combine(installDirectory, "runtime", "node.exe");
            string serverPath = Path.Combine(installDirectory, "app", "engine", "server.js");
            string ffmpegPath = Path.Combine(
                installDirectory,
                "app",
                "node_modules",
                "ffmpeg-static",
                "ffmpeg.exe"
            );
            string ffprobePath = Path.Combine(
                installDirectory,
                "app",
                "node_modules",
                "ffprobe-static",
                "bin",
                "win32",
                "x64",
                "ffprobe.exe"
            );

            RequireFile(nodePath);
            RequireFile(serverPath);
            RequireFile(ffmpegPath);
            RequireFile(ffprobePath);

            string dataDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "EditOfLegends"
            );
            Directory.CreateDirectory(dataDirectory);

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = Quote(serverPath),
                WorkingDirectory = Path.Combine(installDirectory, "app"),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            startInfo.EnvironmentVariables["EOL_AUTH_TOKEN"] = token;
            startInfo.EnvironmentVariables["EOL_DATA_DIR"] = dataDirectory;
            startInfo.EnvironmentVariables["EOL_PORT"] = "4317";
            startInfo.EnvironmentVariables["FFMPEG_PATH"] = ffmpegPath;
            startInfo.EnvironmentVariables["FFPROBE_PATH"] = ffprobePath;
            startInfo.EnvironmentVariables["NODE_ENV"] = "production";

            Process.Start(startInfo);
            for (int attempt = 0; attempt < 40; attempt++)
            {
                Thread.Sleep(250);
                if (EngineIsReady(token))
                {
                    return 0;
                }
            }
            WriteError(dataDirectory, "The analysis engine did not become ready within 10 seconds.");
            return 1;
        }
        catch (Exception error)
        {
            string dataDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "EditOfLegends"
            );
            WriteError(dataDirectory, error.ToString());
            return 1;
        }
    }

    private static string ReadToken(string[] args)
    {
        if (args.Length != 1)
        {
            throw new ArgumentException("Expected one editoflegends:// URL argument.");
        }
        Uri uri;
        if (!Uri.TryCreate(args[0], UriKind.Absolute, out uri) ||
            !String.Equals(uri.Scheme, Scheme, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("Invalid EditOfLegends launch URL.");
        }
        string query = uri.Query.TrimStart('?');
        foreach (string item in query.Split('&'))
        {
            string[] pair = item.Split(new[] { '=' }, 2);
            if (pair.Length == 2 && String.Equals(pair[0], "token", StringComparison.Ordinal))
            {
                string token = Uri.UnescapeDataString(pair[1]);
                if (TokenPattern.IsMatch(token))
                {
                    return token;
                }
            }
        }
        throw new ArgumentException("The launch URL did not contain a valid token.");
    }

    private static bool EngineIsReady(string token)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(EngineUrl);
            request.Method = "GET";
            request.Timeout = 500;
            request.ReadWriteTimeout = 500;
            request.Headers[HttpRequestHeader.Authorization] = "Bearer " + token;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                return response.StatusCode == HttpStatusCode.OK;
            }
        }
        catch
        {
            return false;
        }
    }

    private static void RequireFile(string path)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException("The companion installation is incomplete.", path);
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void WriteError(string dataDirectory, string message)
    {
        try
        {
            Directory.CreateDirectory(dataDirectory);
            File.WriteAllText(Path.Combine(dataDirectory, "launcher-error.log"), message);
        }
        catch
        {
            // The launcher has no UI; if logging fails the panel still reports a timeout.
        }
    }
}
