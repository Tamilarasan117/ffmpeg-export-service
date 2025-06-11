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

app.use(cors({ origin: "*" }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("✅ FFmpeg Export Service is live!");
});

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.statusText}`);
  const buffer = await res.buffer();
  await fs.writeFile(destPath, buffer);
  return destPath;
}

function escapeFFmpegText(text) {
  return String(text || "")
    .replace(/'/g, "\\\\'")
    .replace(/:/g, "\\\\:")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, " ")
    .replace(/(.{1,50})(\s|$)/g, "$1\\n")
    .slice(0, 500); // safe limit
}

app.post("/export-video", async (req, res) => {
  try {
    const { imageList, audioFileUrl, script } = req.body;

    if (!Array.isArray(imageList) || !imageList.length || !audioFileUrl || !Array.isArray(script)) {
      return res.status(400).json({ error: "Invalid input data" });
    }

    const tempDir = path.join("/tmp", uuidv4());
    await fs.mkdir(tempDir, { recursive: true });

    const imageFiles = await Promise.all(
      imageList.map(async (imgUrl, i) => {
        const absoluteUrl = imgUrl.startsWith("http")
          ? imgUrl
          : new URL(imgUrl, BASE_IMAGE_URL).href;

        const ext = path.extname(new URL(absoluteUrl).pathname) || ".jpg";
        const filePath = path.join(tempDir, `image_${i}${ext}`);
        await downloadFile(absoluteUrl, filePath);
        return filePath;
      })
    );

    const audioAbsUrl = audioFileUrl.startsWith("http")
      ? audioFileUrl
      : new URL(audioFileUrl, BASE_IMAGE_URL).href;

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
        ffmpeg(imageFiles[i])
          .loop(durationPerImage)
          .videoFilters([
            {
              filter: "drawtext",
              options: {
                fontfile: fontPath,
                text,
                fontsize: 24,
                fontcolor: "white",
                box: 1,
                boxcolor: "black@0.5",
                boxborderw: 5,
                x: "(w-text_w)/2",
                y: "h-60",
                line_spacing: 5,
                enable: "between(t,0,5)"
              }
            }
          ])
          .outputOptions(["-t", `${durationPerImage}`, "-r", "30", "-pix_fmt", "yuv420p"])
          .on("end", resolve)
          .on("error", (err) => {
            console.error("⚠️ FFmpeg drawtext error:", err.message);
            reject(err);
          })
          .save(outputVideo);
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
        .inputOptions(["-f", "concat", "-safe", "0"])
        .videoCodec("libx264")
        .outputOptions(["-pix_fmt", "yuv420p", "-r", "30"])
        .on("end", resolve)
        .on("error", reject)
        .save(tempConcatPath);
    });

    console.log("🎼 Merging with audio...");
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(tempConcatPath)
        .input(audioFilePath)
        .outputOptions(["-c:v", "copy", "-c:a", "aac", "-shortest"])
        .on("end", resolve)
        .on("error", reject)
        .save(finalOutputPath);
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
