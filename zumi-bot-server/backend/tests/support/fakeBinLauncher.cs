// Windows stand-in for a test's `#!/bin/sh` wrapper (see fakeBin.ts). The app spawns its CLIs directly, and Windows
// can only spawn an exe, so each fake bin is a copy of this one exe next to a `<name>.launch` file holding the command
// line to run in its place (`"node.exe" "fake.mjs"`). Our own arguments go after it untouched, so the JSON a turn passes
// keeps its quoting. The child shares our std handles and joins a kill-on-close job: a test that kills only this
// process (no tree kill) must not leave the fake running with the pipes open.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class FakeBinLauncher
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong a, b, c, d, e, f; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
        IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetCommandLine();

    const uint CREATE_SUSPENDED = 0x4, STARTF_USESTDHANDLES = 0x100, KILL_ON_JOB_CLOSE = 0x2000, BREAKAWAY_OK = 0x800;

    // The raw command line minus our own program name, quoting kept exactly as the caller wrote it.
    static string OwnArgs()
    {
        string line = Marshal.PtrToStringUni(GetCommandLine());
        int i = 0;
        if (line.Length > 0 && line[0] == '"') { i = line.IndexOf('"', 1); i = i < 0 ? line.Length : i + 1; }
        else { while (i < line.Length && line[i] != ' ' && line[i] != '\t') i++; }
        return line.Substring(i);
    }

    static int Main()
    {
        string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
        string launch = Path.ChangeExtension(self, ".launch");
        string prefix = File.ReadAllText(launch, Encoding.UTF8).Trim();

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.Basic.LimitFlags = KILL_ON_JOB_CLOSE | BREAKAWAY_OK;
        SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = (int)STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(-10);
        si.hStdOutput = GetStdHandle(-11);
        si.hStdError = GetStdHandle(-12);
        PROCESS_INFORMATION pi;
        var cmd = new StringBuilder(prefix + OwnArgs());
        if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, null, ref si, out pi))
        {
            Console.Error.WriteLine("fake bin: cannot start " + prefix + ": " + new Win32Exception().Message);
            return 127;
        }
        AssignProcessToJobObject(job, pi.hProcess);
        ResumeThread(pi.hThread);
        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        // Like `exec` on Linux: what the fake started on its own outlives it, so the job only kills on an abnormal end.
        info.Basic.LimitFlags = BREAKAWAY_OK;
        SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        return (int)code;
    }
}
