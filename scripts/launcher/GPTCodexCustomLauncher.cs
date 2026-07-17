using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace GPTCodexCustom.Launcher
{
    internal static class Program
    {
        private const string ProductName = "GPT + Codex Custom";
        private const string GuiScriptRelativePath = @"scripts\Launch-Custom-Gui.ps1";
        private const string ConsoleScriptRelativePath = @"scripts\Launch-Custom.ps1";
        private const string RuntimeRelativePath = @"work\runtime\ChatGPT.exe";

        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            try
            {
                string baseDirectory = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
                if (TryWriteProbe(args, baseDirectory))
                {
                    return 0;
                }

                LauncherOptions options = ParseOptions(args);
                if (options.ShowHelp)
                {
                    ShowInformation(
                        "Double-click this executable for a normal console-free launch.\r\n\r\n" +
                        "Optional arguments:\r\n" +
                        "  --console     Show the PowerShell launch console\r\n" +
                        "  --replace     Replace an existing custom diagnostic session\r\n" +
                        "  --no-update   Skip the automatic source-update check\r\n" +
                        "  --diagnostics Start renderer diagnostics\r\n" +
                        "  --self-test   Run the non-destructive renderer self-test"
                    );
                    return 0;
                }

                string scriptPath = Path.Combine(
                    baseDirectory,
                    options.ConsoleVisible ? ConsoleScriptRelativePath : GuiScriptRelativePath
                );
                if (!File.Exists(scriptPath))
                {
                    throw new FileNotFoundException(
                        "The launcher script is missing. Extract or update the complete GPT + Codex Custom package.",
                        scriptPath
                    );
                }

                string powerShellPath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    @"WindowsPowerShell\v1.0\powershell.exe"
                );
                if (!File.Exists(powerShellPath))
                {
                    throw new FileNotFoundException("Windows PowerShell could not be found.", powerShellPath);
                }

                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = powerShellPath;
                startInfo.WorkingDirectory = baseDirectory;
                startInfo.Arguments = BuildPowerShellArguments(scriptPath, options);
                startInfo.UseShellExecute = options.ConsoleVisible;
                startInfo.CreateNoWindow = !options.ConsoleVisible;
                startInfo.WindowStyle = options.ConsoleVisible
                    ? ProcessWindowStyle.Normal
                    : ProcessWindowStyle.Hidden;

                Process child = Process.Start(startInfo);
                if (child == null)
                {
                    throw new InvalidOperationException("Windows did not start the custom launch process.");
                }
                child.Dispose();
                return 0;
            }
            catch (Exception exception)
            {
                ShowError(exception.Message);
                return 1;
            }
        }

        private static LauncherOptions ParseOptions(string[] args)
        {
            LauncherOptions options = new LauncherOptions();
            foreach (string rawArgument in args)
            {
                string argument = (rawArgument ?? string.Empty).Trim().ToLowerInvariant();
                switch (argument)
                {
                    case "--console":
                        options.ConsoleVisible = true;
                        break;
                    case "--replace":
                        options.ReplaceExisting = true;
                        break;
                    case "--no-update":
                        options.SkipUpdateCheck = true;
                        break;
                    case "--diagnostics":
                        options.Diagnostics = true;
                        break;
                    case "--self-test":
                        options.SelfTest = true;
                        break;
                    case "--help":
                    case "-h":
                    case "/?":
                        options.ShowHelp = true;
                        break;
                    case "":
                        break;
                    default:
                        throw new ArgumentException("Unsupported launcher argument: " + rawArgument);
                }
            }

            if (options.Diagnostics && options.SelfTest)
            {
                throw new ArgumentException("Choose either --diagnostics or --self-test, not both.");
            }
            return options;
        }

        private static string BuildPowerShellArguments(string scriptPath, LauncherOptions options)
        {
            List<string> arguments = new List<string>();
            arguments.Add("-NoLogo");
            arguments.Add("-NoProfile");
            arguments.Add("-NonInteractive");
            arguments.Add("-ExecutionPolicy");
            arguments.Add("Bypass");
            if (!options.ConsoleVisible)
            {
                arguments.Add("-WindowStyle");
                arguments.Add("Hidden");
            }
            arguments.Add("-File");
            arguments.Add(QuoteArgument(scriptPath));

            if (!options.ConsoleVisible)
            {
                arguments.Add("-LauncherProcessId");
                arguments.Add(Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture));
            }
            if (options.ReplaceExisting)
            {
                arguments.Add("-ReplaceExisting");
            }
            if (options.SkipUpdateCheck)
            {
                arguments.Add("-SkipUpdateCheck");
            }
            if (options.Diagnostics)
            {
                arguments.Add("-Diagnostics");
            }
            if (options.SelfTest)
            {
                arguments.Add("-SelfTest");
            }
            return string.Join(" ", arguments.ToArray());
        }

        private static string QuoteArgument(string argument)
        {
            if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                return argument;
            }

            StringBuilder result = new StringBuilder();
            result.Append('"');
            int backslashCount = 0;
            foreach (char character in argument)
            {
                if (character == '\\')
                {
                    backslashCount++;
                    continue;
                }
                if (character == '"')
                {
                    result.Append('\\', backslashCount * 2 + 1);
                    result.Append('"');
                    backslashCount = 0;
                    continue;
                }
                result.Append('\\', backslashCount);
                backslashCount = 0;
                result.Append(character);
            }
            result.Append('\\', backslashCount * 2);
            result.Append('"');
            return result.ToString();
        }

        private static bool TryWriteProbe(string[] args, string baseDirectory)
        {
            if (args.Length == 0 || !string.Equals(args[0], "--launcher-probe", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
            if (args.Length != 2 || string.IsNullOrWhiteSpace(args[1]))
            {
                throw new ArgumentException("--launcher-probe requires exactly one output path.");
            }

            string probePath = Path.GetFullPath(args[1]);
            string parentDirectory = Path.GetDirectoryName(probePath);
            if (string.IsNullOrWhiteSpace(parentDirectory) || !Directory.Exists(parentDirectory))
            {
                throw new DirectoryNotFoundException("The launcher probe output directory does not exist.");
            }

            string json = "{\r\n" +
                "  \"schemaVersion\": 1,\r\n" +
                "  \"launcherKind\": \"native-winexe\",\r\n" +
                "  \"baseDirectory\": \"" + EscapeJson(baseDirectory) + "\",\r\n" +
                "  \"defaultScript\": \"" + EscapeJson(Path.Combine(baseDirectory, GuiScriptRelativePath)) + "\",\r\n" +
                "  \"consoleScript\": \"" + EscapeJson(Path.Combine(baseDirectory, ConsoleScriptRelativePath)) + "\",\r\n" +
                "  \"runtimeExecutable\": \"" + EscapeJson(Path.Combine(baseDirectory, RuntimeRelativePath)) + "\",\r\n" +
                "  \"defaultConsoleVisible\": false,\r\n" +
                "  \"consoleOptInArgument\": \"--console\"\r\n" +
                "}\r\n";
            File.WriteAllText(probePath, json, new UTF8Encoding(false));
            return true;
        }

        private static string EscapeJson(string value)
        {
            return value
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\r", "\\r")
                .Replace("\n", "\\n");
        }

        private static void ShowError(string message)
        {
            MessageBox.Show(
                message,
                ProductName,
                MessageBoxButtons.OK,
                MessageBoxIcon.Error,
                MessageBoxDefaultButton.Button1
            );
        }

        private static void ShowInformation(string message)
        {
            MessageBox.Show(
                message,
                ProductName,
                MessageBoxButtons.OK,
                MessageBoxIcon.Information,
                MessageBoxDefaultButton.Button1
            );
        }

        private sealed class LauncherOptions
        {
            public bool ConsoleVisible { get; set; }
            public bool ReplaceExisting { get; set; }
            public bool SkipUpdateCheck { get; set; }
            public bool Diagnostics { get; set; }
            public bool SelfTest { get; set; }
            public bool ShowHelp { get; set; }
        }
    }
}
