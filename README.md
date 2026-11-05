# yt-clipper

A local web app for downloading videos or audio, with optional clip trimming. It runs on macOS and Windows; the web interface is served at `http://localhost:3000`.

## Requirements

- macOS or Windows
- Node.js 18 or newer
- `yt-dlp`
- `ffmpeg`

### macOS

The easiest way to install these tools is with [Homebrew](https://brew.sh/). If Homebrew is not installed yet, install it using the instructions on its website, then run:

```sh
brew install node yt-dlp ffmpeg
```

### Windows

In PowerShell, install the tools with [WinGet](https://learn.microsoft.com/windows/package-manager/winget/):

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id yt-dlp.yt-dlp --exact
winget install --id Gyan.FFmpeg.Shared --exact
```

If WinGet cannot find a package, install that tool from its official website and ensure its install folder is on your `PATH`. Restart PowerShell after installation.

### Verify the tools

Open a new Terminal (macOS) or PowerShell (Windows) window and check that all three commands are available:

```text
node --version
yt-dlp --version
ffmpeg -version
```

## Run the app

From Terminal, start the app with its full path:

```sh
/Users/<you>/code/youtube_video_downloader/yt-clipper
```

Then open [http://localhost:3000](http://localhost:3000) in your browser. Keep the Terminal window open while using the app. Press **Control-C** in that window to stop the server.

## Add the launcher to your PATH

Adding the project folder to your `PATH` lets you run `yt-clipper` from any directory. The default macOS shell is zsh. Run:

```sh
echo 'export PATH="/Users/<you>/code/youtube_video_downloader:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Now you can launch the app by running:

```sh
yt-clipper
```

If you moved the project folder, replace `/Users/<you>/code/youtube_video_downloader` in the command with its new location.

### Windows

Open PowerShell and run the Windows launcher from the project folder:

```powershell
cd C:\path\to\youtube_video_downloader
.\yt-clipper.cmd
```

Alternatively, run the server directly:

```powershell
node .\server.js
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Keep the PowerShell window open while using the app. Press **Ctrl+C** to stop the server.

#### Add the launcher to your Windows PATH

To run `yt-clipper` from any PowerShell directory, add the project folder to your user `PATH`. Replace the example path with the actual location of this project:

```powershell
$project = 'C:\path\to\youtube_video_downloader'
$userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $project) {
    $newPath = (@($userPath.TrimEnd(';'), $project) | Where-Object { $_ }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
}
$env:Path = "$project;$env:Path"
```

The change applies to new terminals too; the final line updates the current PowerShell session. Then launch the app from any directory:

```powershell
yt-clipper
```

## Downloads and privacy

Temporary downloads are kept in the app's `downloads` folder while the browser receives them. The app removes a download after a completed or canceled transfer. Use this app only for content you own or have permission to download.

## Troubleshooting

- If the launcher says Node.js is required, install Node.js and ensure `node` is on your `PATH`.
- If startup warns that `yt-dlp` or `ffmpeg` is missing, install them and ensure their commands are on your `PATH`.
- If port 3000 is already in use, start the server on another port:

  ```sh
  PORT=3001 yt-clipper
  ```

  Then open [http://localhost:3001](http://localhost:3001).
- On Windows PowerShell, use `$env:PORT = 3001; yt-clipper` to select another port, then open [http://localhost:3001](http://localhost:3001).
