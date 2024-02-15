import OpenAI from 'openai';
import * as dotenv from "dotenv";
import fs from 'fs'
dotenv.config();

const file = fs.readFile('./part_1.mp3')

const openai = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'], // This is the default and can be omitted
  model: "whisper-1"
});

