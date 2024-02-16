import OpenAI from "openai";
import * as dotenv from "dotenv";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import path from "path";
import { promises as fsPromises } from "fs";

dotenv.config();

const openai = new OpenAI(process.env["OPENAI_API_KEY"]);
// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath.path);

function normalizeAudio(filePath, normalizedFilePath) {
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .outputOptions([
        '-af', 'loudnorm=I=-23:LRA=7:TP=-2.0', // Example loudnorm settings
      ])
      .saveToFile(normalizedFilePath)
      .on('end', () => {
        console.log('Normalization done.');
        resolve();
      })
      .on('error', (err) => {
        console.log('Error during normalization:', err);
        reject(err);
      });
  });
}


async function processAudio(filePath, segmentDuration, outputFolder) {
  // Extract the original file name without extension and append ".normalized.mp3"
  const fileNameWithoutExt = path.basename(filePath, path.extname(filePath));
  const normalizedFilePath = path.join(outputFolder, `${fileNameWithoutExt}.normalized.mp3`);

  // First, normalize the entire audio file
  await normalizeAudio(filePath, normalizedFilePath);

  // Then, split the normalized audio file into segments
  await splitMp3(normalizedFilePath, segmentDuration, outputFolder);
}

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
    if (transcription && transcription.text) {
      return transcription.text;
    } else {
      console.error(
        "Unexpected or missing transcription text:",
        JSON.stringify(transcription, null, 2)
      );
      return "";
    }
  } catch (error) {
    console.error("Error during transcription:", error);
    return "";
  }
}


let debugMode = false; // Set to false to process all chunks
const debugLimit = 6; // Number of chunks to process in debug mode
// Global variable to hold the context from the end of the last processed batch
let ongoingContext = "";

async function processChunksWithContext(folderPath, outputFile) {
  const files = await fsPromises
    .readdir(folderPath)
    .then((f) => f.filter((file) => path.extname(file) === ".mp3"));
  let batchText = ""; // Accumulate text for the current batch
  let fileCount = 0; // Counter to manage batch size
  let processedChunksCount = 0; // Keep track of how many chunks have been processed for debugMode

  for (const file of files) {
    if (debugMode && processedChunksCount >= debugLimit) {
      console.log(`Debug mode is active. Limited processing to ${debugLimit} chunks.`);
      break; // Exit early in debug mode after processing the limit
    }

    console.log(`Transcribing ${file}...`);
    const transcription = await transcribeSegment(`${folderPath}/${file}`);
    // Add the ongoing context at the start of the first chunk in a new batch
    if (fileCount % 3 === 0) {
      batchText += ongoingContext ? `${ongoingContext}\n\n` : "";
    }
    batchText += transcription + "\n\n"; // Append current transcription to the batch

    if (++fileCount % 3 === 0 || fileCount === files.length) {
      // Process in batches of 3 or the remaining chunks
      const processedText = await processWithGPT4(batchText, ongoingContext);

      await fsPromises.appendFile(outputFile, processedText + "\n\n");
      batchText = ""; // Reset batch text for the next batch

      // Extract context from the end of this batch to use for the next one
      ongoingContext = extractLastSentence(transcription);
      processedChunksCount += 3; // Update processed chunks count
    }
  }

  console.log("Final transcription processed and saved to", outputFile);
}


// Example function to extract a snippet of text to serve as context for the next batch
function extractContextForNextBatch(text) {
  // This could be the last few sentences or a specific portion of text
  const sentences = text.match(/[^\.!\?]+[\.!\?]+/g) || [];
  const contextLength = 3; // Number of sentences to carry forward as context
  return sentences.slice(-contextLength).join(" ");
}
async function processWithGPT4(text, context = "") {
  // Construct the introduction part of the prompt
  const promptIntro = `You are a helpful assistant. This is an interview transcription. The interviewer's name is Oliver and the interviewee's name is David.`;
  
  // Construct the ending part of the prompt with instructions
  const promptOutro = `Be precise. Do not add anything or guess what the content might be. Format it properly as an interview, ensuring there are no overlaps in content.\n\n${text}`;

  // Conditionally construct the context part of the prompt, ensuring smooth integration
  const contextPrompt = context ? ` Given the context: "${context}", continue ensuring it flows naturally and there are no overlaps.` : "";

  // Combine the parts to form the full prompt
  const fullPrompt = `${promptIntro}${contextPrompt}${promptOutro}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo-preview", // Adjust as necessary
    messages: [{
      role: "system",
      content: fullPrompt,
    }],
    temperature: 0.5,
    max_tokens: 2048,
    n: 1,
    stop: null,
  });

  if (response && response.choices && response.choices.length > 0) {
    return response.choices[0].message.content.trim();
  } else {
    console.error("Unexpected or missing response data:", JSON.stringify(response, null, 2));
    return "";
  }
}


// Function to extract the last sentence from a transcription
function extractLastSentence(text) {
  const sentences = text.match(/[^\.!\?]+[\.!\?]+/g);
  return sentences && sentences.length > 0 ? sentences.pop().trim() : "";
}
async function clearOutputFile(outputFile) {
  try {
    await fsPromises.writeFile(outputFile, "", "utf8");
    console.log(`Cleared old content in ${outputFile}.`);
  } catch (error) {
    console.error(`Error clearing the output file: ${error}`);
  }
}

// Define paths, segment duration, and initiate the process
const mp3FilePath = "./part_1.mp3";
const segmentDuration = 25; // Duration of each segment in seconds
const outputFolder = "./outputSegments";
const finalTranscriptionFile = "./finalTranscription.txt";

async function main() {
  await clearOutputFile(finalTranscriptionFile); // Clear the output file first
  processAudio(mp3FilePath, segmentDuration, outputFolder)
    .then(() => processChunksWithContext(outputFolder, finalTranscriptionFile))
    .catch((error) => console.error("Error in processing:", error));
}

main();
