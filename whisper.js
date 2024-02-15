import OpenAI from 'openai';
import * as dotenv from "dotenv";
import fs from 'fs'
dotenv.config();

const filePath = './part_1.mp3';

const openai = new OpenAI(process.env['OPENAI_API_KEY']);

const transcription = await openai.audio.transcriptions.create({
  file: fs.createReadStream(filePath),
  model: "whisper-1"
});

console.log(transcription)
