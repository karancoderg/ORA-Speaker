import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { generateDownloadUrl } from '@/lib/s3Client';
import { ExternalAIClient } from '@/lib/externalAIClient';
import { GeminiProcessor } from '@/lib/geminiProcessor';
import { ExternalAIAnalysis } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { handleError, createErrorResponse, getStatusCode } from '@/lib/errorHandler';

// Create logger instance for analyze route
const logger = createLogger('AnalyzeAPI');

/**
 * POST /api/analyze
 * Orchestrates video analysis workflow with external AI integration:
 * 1. Validates request body (userId, videoPath/s3Key)
 * 2. Downloads video from S3
 * 3. Attempts external AI analysis (if enabled)
 * 4. Falls back to direct Gemini analysis on failure
 * 5. Processes JSON with Gemini (if external AI succeeded)
 * 6. Inserts feedback record into feedback_sessions table
 * 7. Returns success response with feedback text to client
 */
export async function POST(request: NextRequest) {
  const requestTimer = logger.startTimer('analyze_request');
  
  try {
    // 1. Parse and validate request body
    const body = await request.json();
    const { userId, videoPath } = body;

    // Validate required fields
    if (!userId || !videoPath) {
      const errorResponse = createErrorResponse('validation');
      logger.warn('Validation failed: missing required fields', {
        hasUserId: !!userId,
        hasVideoPath: !!videoPath,
      });
      return NextResponse.json(errorResponse, { status: getStatusCode('validation') });
    }

    // Validate environment variables
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      logger.error('GEMINI_API_KEY not configured', {
        userId,
        videoPath,
      });
      const errorResponse = createErrorResponse('configuration');
      return NextResponse.json(errorResponse, { status: getStatusCode('configuration') });
    }

    logger.info('Starting video analysis', {
      userId,
      videoPath,
    });

    // 2. Create signed URL from AWS S3
    let signedUrl: string;
    try {
      const urlTimer = logger.startTimer('s3_url_generation');
      signedUrl = await generateDownloadUrl(videoPath, 3600); // 1 hour for upload
      logger.endTimer(urlTimer);
    } catch (error) {
      logger.error('Failed to generate signed URL', {
        error: error instanceof Error ? error.message : String(error),
        videoPath,
      });
      const { response, statusCode } = handleError(error);
      return NextResponse.json(response, { status: statusCode });
    }

    // 3. Download video from S3
    let videoBuffer: Buffer;
    try {
      const downloadTimer = logger.startTimer('s3_video_download');
      const videoResponse = await fetch(signedUrl);
      if (!videoResponse.ok) {
        throw new Error(`Failed to download video: ${videoResponse.statusText}`);
      }
      const arrayBuffer = await videoResponse.arrayBuffer();
      videoBuffer = Buffer.from(arrayBuffer);
      logger.endTimer(downloadTimer);
      logger.info('Video downloaded successfully', {
        size: videoBuffer.length,
      });
    } catch (error) {
      logger.error('Failed to download video from S3', {
        error: error instanceof Error ? error.message : String(error),
        videoPath,
      });
      const { response, statusCode } = handleError(error);
      return NextResponse.json(response, { status: statusCode });
    }

    // 4. Attempt external AI analysis (if enabled) with fallback to direct Gemini
    let feedback: string;
    let rawAnalysis: ExternalAIAnalysis | null = null;
    let analysisSource: 'external_ai' | 'gemini_direct' | 'hybrid' = 'gemini_direct';

    // Check feature flag
    const externalAIEnabled = process.env.EXTERNAL_AI_ENABLED === 'true';
    
    if (externalAIEnabled) {
      // Try external AI analysis first
      try {
        logger.info('External AI enabled, attempting external analysis');
        
        // Initialize External AI Client
        const externalAIConfig = {
          apiUrl: process.env.EXTERNAL_AI_API_URL || 'http://10.59.19.205:9000/analyze/',
          timeout: parseInt(process.env.EXTERNAL_AI_TIMEOUT || '240000', 10),
          maxRetries: 3,
        };

        const externalAIClient = new ExternalAIClient(externalAIConfig);

        // Send video to external AI
        rawAnalysis = await externalAIClient.analyzeVideo(videoBuffer, 'video/mp4');
        
        logger.info('External AI analysis successful, processing with Gemini');

        // Initialize Gemini Processor
        const geminiProcessor = new GeminiProcessor({
          apiKey: geminiApiKey,
          model: 'gemini-2.5-flash',
        });

        // Process JSON analysis with Gemini
        feedback = await geminiProcessor.processFeedback(rawAnalysis, {
          fileName: videoPath,
        });

        analysisSource = 'hybrid';
        logger.info('Hybrid analysis completed successfully');

      } catch (externalError) {
        // Log fallback event with reason
        const errorMessage = externalError instanceof Error ? externalError.message : 'Unknown error';
        logger.logFallback({
          reason: errorMessage,
          originalError: errorMessage,
          fallbackMethod: 'direct_gemini',
          triggeredBy: 'external_ai_failure',
        });

        // Fall back to direct Gemini analysis
        try {
          feedback = await analyzeWithDirectGemini(videoBuffer, videoPath, geminiApiKey);
          analysisSource = 'gemini_direct';
          logger.info('Fallback to direct Gemini completed successfully');
        } catch (geminiError) {
          logger.error('Direct Gemini fallback also failed', {
            error: geminiError instanceof Error ? geminiError.message : String(geminiError),
          });
          const { response, statusCode } = handleError(geminiError);
          return NextResponse.json(response, { status: statusCode });
        }
      }
    } else {
      // External AI disabled, use direct Gemini
      logger.info('External AI disabled, using direct Gemini analysis');
      try {
        feedback = await analyzeWithDirectGemini(videoBuffer, videoPath, geminiApiKey);
        analysisSource = 'gemini_direct';
      } catch (error) {
        logger.error('Failed to analyze video with Gemini', {
          error: error instanceof Error ? error.message : String(error),
        });
        const { response, statusCode } = handleError(error);
        return NextResponse.json(response, { status: statusCode });
      }
    }

    // 5. Insert feedback record into feedback_sessions table
    let feedbackSessionId: string;
    try {
      const dbTimer = logger.startTimer('database_insert');
      const { data, error: dbError } = await supabaseServer
        .from('feedback_sessions')
        .insert({
          user_id: userId,
          video_path: videoPath,
          feedback_text: feedback,
          raw_analysis: rawAnalysis, // Store JSON from external AI (null if direct Gemini)
          analysis_source: analysisSource, // Track which analysis method was used
        })
        .select('id')
        .single();

      if (dbError || !data) {
        logger.error('Failed to insert feedback into database', {
          error: dbError?.message || 'No data returned',
        });
        const errorResponse = createErrorResponse('database', dbError?.message);
        return NextResponse.json(errorResponse, { status: getStatusCode('database') });
      }

      feedbackSessionId = data.id;
      logger.endTimer(dbTimer);
    } catch (error) {
      logger.error('Database operation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      const { response, statusCode } = handleError(error);
      return NextResponse.json(response, { status: statusCode });
    }

    // 6. Return success response with feedback text and session ID to client
    const totalDuration = logger.endTimer(requestTimer);
    logger.info('Analysis request completed successfully', {
      feedbackSessionId,
      analysisSource,
      totalDuration,
    });

    return NextResponse.json({
      success: true,
      feedback,
      feedbackSessionId,
    });
  } catch (error) {
    // Handle unexpected errors
    logger.error('Unexpected error in analyze route', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    const { response, statusCode } = handleError(error);
    return NextResponse.json(response, { status: statusCode });
  }
}

/**
 * Helper function to analyze video directly with Gemini (fallback method)
 * @param videoBuffer - Video file as Buffer
 * @param videoPath - Path to video in S3
 * @param geminiApiKey - Gemini API key
 * @returns Feedback text from Gemini
 */
async function analyzeWithDirectGemini(
  videoBuffer: Buffer,
  videoPath: string,
  geminiApiKey: string
): Promise<string> {
  const fileManager = new GoogleAIFileManager(geminiApiKey);
  const genAI = new GoogleGenerativeAI(geminiApiKey);

  // Write video to temp file
  const fs = await import('fs/promises');
  const path = await import('path');
  const os = await import('os');

  const tempDir = os.tmpdir();
  const tempFilePath = path.join(tempDir, `video-${Date.now()}.mp4`);

  await fs.writeFile(tempFilePath, videoBuffer);

  try {
    // Upload to Gemini
    const uploadResult = await fileManager.uploadFile(tempFilePath, {
      mimeType: 'video/mp4',
      displayName: videoPath,
    });

    // Clean up temp file
    await fs.unlink(tempFilePath);

    // Wait for file to be processed
    let file = await fileManager.getFile(uploadResult.file.name);
    while (file.state === 'PROCESSING') {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      file = await fileManager.getFile(uploadResult.file.name);
    }

    if (file.state === 'FAILED') {
      throw new Error('Video processing failed');
    }

    // Generate content with the uploaded file
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `Analyze this public speaking presentation video and provide detailed, constructive feedback. Focus on:

1. **Speaking Pace & Clarity**: Is the pace appropriate? Is speech clear and articulate?
2. **Filler Words**: Count and identify filler words (um, uh, like, you know, etc.)
3. **Body Language**: Assess posture, gestures, and movement
4. **Eye Contact**: Evaluate engagement with the audience/camera
5. **Tone & Volume**: Is the tone engaging? Is volume appropriate?
6. **Overall Presentation Skills**: Confidence, structure, engagement

Format your response with:
- **Strengths**: 2-3 specific positive observations
- **Areas for Improvement**: 2-3 actionable suggestions
- **Overall Assessment**: Brief summary with encouragement

Be constructive, specific, and encouraging.`;

    const result = await model.generateContent([
      prompt,
      {
        fileData: {
          fileUri: file.uri,
          mimeType: file.mimeType,
        },
      },
    ]);

    const feedback = result.response.text();

    // Clean up uploaded file from Gemini
    await fileManager.deleteFile(uploadResult.file.name);

    if (!feedback) {
      throw new Error('Gemini API returned empty feedback');
    }

    return feedback;
  } catch (error) {
    // Clean up temp file if it still exists
    try {
      await fs.unlink(tempFilePath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}
