# DemoMed Healthcare API Assessment

This repository contains my solution for the DemoMed Healthcare API coding assessment.

## Overview
The script:
- Fetches all patient records from a paginated API
- Handles rate limiting (429) and intermittent server failures (500/503) with retry logic
- Normalizes inconsistent or malformed data
- Computes patient risk scores based on:
  - Blood pressure
  - Temperature
  - Age
- Generates required alert lists:
  - High-risk patients (total risk ≥ 4)
  - Fever patients (temperature ≥ 99.6°F)
  - Data quality issues (invalid or missing vitals)
- Submits results to the assessment API endpoint

## Tech Stack
- Node.js 18+
- TypeScript
- Native Fetch API

## Running the Script
```bash
npm install
npm run start
