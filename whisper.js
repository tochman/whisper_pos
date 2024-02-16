import OpenAI from "openai";
import * as dotenv from "dotenv";
import fs from "fs"; // Used for createReadStream only
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import path from "path";
import { promises as fsPromises } from "fs"; // Correctly using fs promises

dotenv.config();

const openai = new OpenAI(process.env["OPENAI_API_KEY"]);
// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath.path);

function splitMp3(filePath, segmentDuration, outputFolder) {
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .output(`${outputFolder}/segment_%03d.mp3`)
      .outputOptions([
        `-f segment`,
        `-segment_time ${segmentDuration}`,
        `-c copy`,
      ])
      .on("end", function () {
        console.log("Splitting done.");
        resolve();
      })
      .on("error", function (err) {
        console.log("Error:", err);
        reject(err);
      })
      .run();
  });
}

async function transcribeSegment(filePath) {
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
      language: "sv",
      prompt:
        "Intervjuaren heter Oliver och den intervjuade heter David. Försök att identifiera 'hmm' och 'mm...' ljud och ignorera dem om möjligt. Den intervjuade pratar tyst.",
    });

    // Extracting transcription text directly from the `text` key
    if (transcription && transcription.text) {
      return transcription.text;
    } else {
      console.error(
        "Unexpected or missing transcription text:",
        JSON.stringify(transcription, null, 2)
      );
      return response.data.choices[0].message.content; // Return an empty string or handle as needed
    }
  } catch (error) {
    console.error("Error during transcription:", error);
    return ""; // Return an empty string or handle the error as needed
  }
}

let previousContext = ""; // Initialize an empty context
const debugMode = true; // Toggle this to switch between debugging and full processing

async function processChunksWithMemory(folderPath, outputFile) {
  const files = await fsPromises
    .readdir(folderPath)
    .then((f) => f.filter((file) => path.extname(file) === ".mp3"));
  let lastSummary = ""; // Stores the last summary generated
  let processedChunksCount = 0; // Keep track of how many chunks have been processed

  for (const file of files) {
    console.log(`Transcribing ${file}...`);
    const transcription = await transcribeSegment(`${folderPath}/${file}`);
    const summary = await summarizeTranscription(transcription); // Generate summary for the current chunk

    // Use the last summary as context for the next chunk's transcription, if available
    let combinedText =
      lastSummary.length > 0
        ? lastSummary + "\n\n" + transcription
        : transcription;

    // Store the current summary for the next iteration, if not in debug mode or if it's the first iteration
    if (!debugMode || processedChunksCount === 0) {
      lastSummary = summary;
    }

    // Process the combined text with GPT-4 for further refinement or formatting
    const processedText = await processWithGPT4(combinedText);
    await fsPromises.appendFile(outputFile, processedText + "\n\n");

    processedChunksCount++;
    // Check if in debug mode and limit has been reached
    if (debugMode && processedChunksCount >= 9) {
      console.log("Debug mode is active. Limited processing to 3 chunks.");
      break; // Exit the loop early in debug mode
    }
  }

  console.log("Final transcription processed and saved to", outputFile);
}

async function processWithGPT4(text) {
  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo-preview",
    messages: [
      {
        role: "system",
        content: `You are a helpful assistant. This is an interview transcription. The language is Swedish. The intevjuer's name is Oliver and the object 's name is David. Format it properly as an interview and correct any transcription errors. Use a text format I can copy and paste into a Google Document:\n\n${text}`,
      },
    ],
    temperature: 0.5,
    max_tokens: 1024,
    n: 1,
    stop: null,
  });

  if (response && response.choices && response.choices.length > 0) {
    // Access the first completion's message content directly
    const completionText = response.choices[0].message.content;
    return completionText.trim();
  } else {
    console.error(
      "Unexpected or missing response data:",
      JSON.stringify(response, null, 2)
    );
    return "";
  }
}

async function summarizeTranscription(text) {
  const response = await openai.completions.create({
    model: "gpt-3.5-turbo-instruct", // Updated to use the recommended replacement
    prompt: `Summarize the following interview segment, focusing on key points and discarding any unnecessary details. Ensure the summary is concise and captures the essence of the discussion:\n\n${text}`,
    temperature: 0.7,
    max_tokens: 150, // Adjust based on your summary length requirements
    top_p: 1.0,
    frequency_penalty: 0.0,
    presence_penalty: 0.0,
  });

  if (response && response.choices && response.choices.length > 0) {
    return response.choices[0].text.trim();
  } else {
    console.error("Failed to generate summary:", response);
    return ""; // Handle as needed
  }
}


async function clearOutputFile(outputFile) {
  try {
    await fsPromises.writeFile(outputFile, "", "utf8");
    console.log(`Cleared old content in ${outputFile}.`);
  } catch (error) {
    console.error(`Error clearing the output file: ${error}`);
  }
}

// Define your paths and segment duration
const mp3FilePath = "./part_1.mp3";
const segmentDuration = 20; // Duration of each segment in seconds
const outputFolder = "./outputSegments";
const finalTranscriptionFile = "./finalTranscription.txt";

// Let's do this:
async function main() {
  await clearOutputFile(finalTranscriptionFile); // Clear the output file first
  splitMp3(mp3FilePath, segmentDuration, outputFolder)
    .then(() => processChunksWithMemory(outputFolder, finalTranscriptionFile))
    .catch((error) => console.error("Error in processing:", error));
}

main();
