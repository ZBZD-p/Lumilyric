// Lumilyric.exe: starts the player with the Python that sits next to it, without a console window.
// Compiled by desktop\build.py with the C# compiler that is part of Windows (.NET Framework 4).
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class Launcher
{
    [STAThread]
    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string py = Path.Combine(dir, "runtime", "pythonw.exe");
        string app = Path.Combine(dir, "desktop", "app.py");
        if (!File.Exists(py) || !File.Exists(app))
        {
            MessageBox.Show("文件不完整：找不到 runtime\\pythonw.exe 或 desktop\\app.py。\n请把整个文件夹重新解压一次。",
                            "Lumilyric", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        var si = new ProcessStartInfo(py, "\"" + app + "\"");
        si.WorkingDirectory = dir;
        si.UseShellExecute = false;
        // nothing from a Python installed on this PC may leak in
        foreach (string k in new[] { "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE", "VIRTUAL_ENV" })
            si.EnvironmentVariables.Remove(k);
        try { Process.Start(si); }
        catch (Exception e)
        {
            MessageBox.Show("启动失败：" + e.Message, "Lumilyric", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        return 0;
    }
}
