using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;

internal static class HtmlSingleFilePackLauncher
{
    private const string PayloadResource = "HtmlSingleFilePack.Payload.zip";
    private const string RuntimeVersion = "__RUNTIME_VERSION__";

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length > 2 || (args.Length > 0 && args[0] == "--help"))
            {
                Console.WriteLine("Usage: HtmlSingleFilePack.exe [input-directory] [output-directory]");
                Console.WriteLine("Defaults: current directory for input, .\\dist for output.");
                return args.Length > 2 ? 2 : 0;
            }

            string inputDirectory = Path.GetFullPath(args.Length > 0 ? args[0] : Environment.CurrentDirectory);
            string outputDirectory = Path.GetFullPath(args.Length > 1 ? args[1] : Path.Combine(Environment.CurrentDirectory, "dist"));
            if (!Directory.Exists(inputDirectory)) throw new DirectoryNotFoundException("Input directory not found: " + inputDirectory);

            string cacheRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "h", RuntimeVersion);
            string nodePath = Path.Combine(cacheRoot, "node.exe");
            if (!File.Exists(nodePath))
            {
                Directory.CreateDirectory(cacheRoot);
                using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResource))
                {
                    if (payload == null) throw new InvalidOperationException("Embedded build runtime is missing.");
                    using (ZipArchive archive = new ZipArchive(payload, ZipArchiveMode.Read)) archive.ExtractToDirectory(cacheRoot);
                }
            }

            string builderPath = Path.Combine(cacheRoot, "scripts", "build.mjs");
            if (!File.Exists(builderPath) || !File.Exists(nodePath)) throw new InvalidOperationException("Could not extract the embedded build runtime.");
            Directory.CreateDirectory(Path.Combine(cacheRoot, ".build-work"));
            Directory.CreateDirectory(Path.Combine(cacheRoot, ".bundle-work"));
            Directory.CreateDirectory(outputDirectory);

            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = nodePath;
            start.Arguments = "\"" + builderPath + "\"";
            start.WorkingDirectory = cacheRoot;
            start.UseShellExecute = false;
            start.EnvironmentVariables["HTMLPACK_INPUT_DIR"] = inputDirectory;
            start.EnvironmentVariables["HTMLPACK_OUTPUT_DIR"] = outputDirectory;
            start.EnvironmentVariables["FORCE_COLOR"] = "0";
            Process process = Process.Start(start);
            process.WaitForExit();
            return process.ExitCode;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("HTML pack failed: " + error.Message);
            return 1;
        }
    }
}
