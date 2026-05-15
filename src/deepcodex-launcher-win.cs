using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class DeepCodexLauncher
{
    [STAThread]
    private static int Main()
    {
        try
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string runtimeScript = Path.Combine(baseDir, "runtime", "scripts", "start-deepcodex.ps1");
            string sourceTreeScript = Path.Combine(baseDir, "scripts", "start-deepcodex.ps1");
            string script = File.Exists(runtimeScript) ? runtimeScript : sourceTreeScript;

            if (!File.Exists(script))
            {
                MessageBox.Show(
                    "start-deepcodex.ps1 was not found.\n\nExpected:\n" + runtimeScript,
                    "DeepCodex",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 2;
            }

            string workingDirectory = Directory.GetParent(Directory.GetParent(script).FullName).FullName;
            var startInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File " + Quote(script),
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            startInfo.EnvironmentVariables["DEEPCODEX_LAUNCHER_PID"] = Process.GetCurrentProcess().Id.ToString();

            using (Process process = Process.Start(startInfo))
            {
                if (process == null)
                {
                    MessageBox.Show("Failed to start PowerShell.", "DeepCodex", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 3;
                }
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.ToString(), "DeepCodex", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }
}
