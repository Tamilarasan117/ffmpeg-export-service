import express from "express";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_IMAGE_URL = process.env.BASE_IMAGE_URL || "";

app.get("/", (req, res) => {
  res.send("✅ FFmpeg Export Service is live!");
});

app.use(cors({ origin: "*" }));
app.use(express.json());

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.statusText}`);
  const buffer = await res.buffer();
  await fs.writeFile(destPath, buffer);
  return destPath;
}

function escapeFFmpegText(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

app.post("/export-video", async (req, res) => {
  try {
    const { imageList, audioFileUrl, script } = req.body;

    if (!Array.isArray(imageList) || !imageList.length || !audioFileUrl || !script || !Array.isArray(script)) {
      return res.status(400).json({ error: "Invalid input data" });
    }

    const tempDir = path.join("/tmp", uuidv4());
    await fs.mkdir(tempDir, { recursive: true });

    const imageFiles = await Promise.all(
      imageList.map(async (imgUrl, i) => {
        let absoluteUrl;
        try {
          absoluteUrl = imgUrl.startsWith("http")
            ? imgUrl
            : new URL(imgUrl, BASE_IMAGE_URL || "http://localhost").href;
        } catch (err) {
          throw new Error(`Invalid image URL: ${imgUrl}`);
        }

        console.log("📸 Downloading image:", absoluteUrl);

        const ext = path.extname(new URL(absoluteUrl).pathname) || ".jpg";
        const filePath = path.join(tempDir, `image_${i}${ext}`);
        await downloadFile(absoluteUrl, filePath);
        return filePath;
      })
    );

    let audioAbsUrl;
    try {
      audioAbsUrl = audioFileUrl.startsWith("http")
        ? audioFileUrl
        : new URL(audioFileUrl, BASE_IMAGE_URL || "http://localhost").href;
    } catch (err) {
      throw new Error(`Invalid audio URL: ${audioFileUrl}`);
    }

    console.log("🎧 Downloading audio:", audioAbsUrl);

    const audioExt = path.extname(new URL(audioAbsUrl).pathname) || ".mp3";
    const audioFilePath = path.join(tempDir, `audio${audioExt}`);
    await downloadFile(audioAbsUrl, audioFilePath);

    const fontPath = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    const durationPerImage = 5;
    const videoSegments = [];

    for (let i = 0; i < imageFiles.length; i++) {
      const text = escapeFFmpegText(script[i]?.ContentText || "");
      const outputVideo = path.join(tempDir, `video_${i}.mp4`);

      console.log(`🎞️ Generating segment ${i + 1}/${imageFiles.length}`);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(imageFiles[i])
          .loop(durationPerImage)
          .videoFilter(
            `drawtext=fontfile='${fontPath}':text='${text}':fontcolor=white:fontsize=24:box=1:boxcolor=0x00000099:boxborderw=5:x=(w-text_w)/2:y=h-60`
          )
          .outputOptions(["-t", `${durationPerImage}`, "-r 30", "-pix_fmt yuv420p"])
          .save(outputVideo)
          .on("end", resolve)
          .on("error", reject);
      });

      videoSegments.push(outputVideo);
    }

    const filelistPath = path.join(tempDir, "filelist.txt");
    await fs.writeFile(filelistPath, videoSegments.map(v => `file '${v}'`).join("\n"));

    const tempConcatPath = path.join(tempDir, `concat_${uuidv4()}.mp4`);
    const finalOutputPath = path.join(tempDir, `output_${uuidv4()}.mp4`);

    console.log("🔗 Concatenating segments...");
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(filelistPath)
        .inputOptions(["-f concat", "-safe 0"])
        .videoCodec("libx264")
        .outputOptions(["-pix_fmt yuv420p", "-r 30"])
        .save(tempConcatPath)
        .on("end", resolve)
        .on("error", reject);
    });

    console.log("🎼 Merging with audio...");
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(tempConcatPath)
        .input(audioFilePath)
        .outputOptions(["-c:v copy", "-c:a aac", "-shortest"])
        .save(finalOutputPath)
        .on("end", resolve)
        .on("error", reject);
    });

    const fileBuffer = await fs.readFile(finalOutputPath);
    const base64 = fileBuffer.toString("base64");

    await fs.rm(tempDir, { recursive: true, force: true });

    res.json({ result: `data:video/mp4;base64,${base64}` });
  } catch (error) {
    console.error("🚨 Export video error:", error);
    res.status(500).json({ error: "Export failed", details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ FFmpeg Export Service running at: http://localhost:${PORT}`);
});
