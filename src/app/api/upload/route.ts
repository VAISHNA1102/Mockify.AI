import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { extractAndChunkDocument, extractAndParseMCQs, isLikelyScanned, validateExtractionQuality } from '@/lib/langchain-extraction'
import { generateEmbeddings } from '@/lib/huggingface-embeddings'
import { extractAndChunkPDF, sanitizeChunkText, CHUNK_STRATEGIES } from '@/lib/pdf-chunking'
import { extractSyllabusTopics, extractTopicsWithPatterns, createTopicBasedChunks } from '@/lib/syllabus-extraction'

// Use service role for file uploads
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Helper function to sanitize text for PostgreSQL
// IMPORTANT: Does NOT truncate - preserves full text length (67K+ chars)
// Only removes null bytes and control characters that break PostgreSQL
function sanitizeTextForDB(text: string): string | null {
  if (!text || typeof text !== 'string') {
    return null
  }
  
  try {
    // Remove all problematic characters that PostgreSQL can't handle
    // BUT keep full text length - no truncation!
    const cleaned = text
      // Remove null bytes and all control characters
      .replace(/\u0000/g, '') // Null bytes
      .replace(/[\u0001-\u0008]/g, '') // Control characters
      .replace(/\u000B/g, '') // Vertical tab
      .replace(/\u000C/g, '') // Form feed
      .replace(/[\u000E-\u001F]/g, '') // More control characters
      .replace(/[\u007F-\u009F]/g, '') // DEL and high control characters
      .replace(/\uFEFF/g, '') // BOM (Byte Order Mark)
      .replace(/[\u2028\u2029]/g, '') // Line/paragraph separators
      // Remove any remaining problematic Unicode sequences
      .replace(/\\u0000/g, '') // Escaped null bytes
      .replace(/\\\\u0000/g, '') // Double-escaped null bytes
      // Normalize whitespace and line breaks
      .replace(/\r\n/g, '\n') // Normalize Windows line endings
      .replace(/\r/g, '\n') // Normalize old Mac line endings
      .replace(/\s+/g, ' ') // Collapse multiple spaces
      .replace(/\n+/g, '\n') // Collapse multiple newlines
      .trim()
    
    // Additional safety check - ensure no null bytes remain
    if (cleaned.includes('\u0000') || cleaned.includes('\\u0000')) {
      console.warn('Null bytes detected after sanitization, performing aggressive cleanup')
      // More aggressive cleanup
      return cleaned
        .split('')
        .filter(char => char.charCodeAt(0) > 31 || char === '\n' || char === '\t')
        .join('')
        .trim()
    }
    
    // Return null if empty or too short
    return cleaned.length > 10 ? cleaned : null
  } catch (error) {
    console.error('Error sanitizing text:', error)
    return null
  }
}

export async function POST(request: NextRequest) {
  try {
    // Get auth token from Authorization header
    const authHeader = request.headers.get('authorization')
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.error('No authorization header found')
      return NextResponse.json(
        { error: 'Authentication required - please login' },
        { status: 401 }
      )
    }

    const token = authHeader.replace('Bearer ', '')
    
    // Create admin client with service role for server-side operations
    const { createClient: createAdminClient } = await import('@supabase/supabase-js')
    const supabaseAdmin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    
    // Verify the user token
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)

    if (authError || !user) {
      console.error('Token verification failed:', authError)
      return NextResponse.json(
        { error: 'Invalid authentication token' },
        { status: 401 }
      )
    }

    const effectiveUserId = user.id
    console.log('Processing file upload for authenticated user:', effectiveUserId)

    // Ensure user exists in public.users table
    try {
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('id', effectiveUserId)
        .single()

      if (!existingUser) {
        const { error: createUserError } = await supabase
          .from('users')
          .insert({
            id: effectiveUserId,
            name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'User',
            email: user.email || '',
            exam_type: null,
            language: 'English',
            created_at: new Date().toISOString()
          })

        if (createUserError) {
          console.error('Error creating user record:', createUserError)
        } else {
          console.log('User record created successfully')
        }
      }
    } catch (error) {
      console.log('User record handling:', error)
    }

    const formData = await request.formData()
    const file = formData.get('file') as File
    const materialType = (formData.get('material_type') as string) || 'notes'
    const formExamType = formData.get('exam_type') as string

    if (!file) {
      return NextResponse.json(
        { error: 'No file uploaded' },
        { status: 400 }
      )
    }

    console.log('Upload request:', {
      fileName: file.name,
      materialType,
      formExamType,
      fileSize: file.size,
      fileType: file.type
    })

    // Validate file type
    const allowedTypes = [
      'application/pdf',
      'image/jpeg',
      'image/jpg', 
      'image/png',
      'image/webp',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]

    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { error: 'Unsupported file type. Please upload PDF, image, or text files.' },
        { status: 400 }
      )
    }

    // Validate file size (10MB limit)
    const maxSize = 1000 * 1024 * 1024 // 10MB
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: 'File too large. Maximum size is 1000MB.' },
        { status: 400 }
      )
    }

    // Generate unique filename with sanitization
    const timestamp = Date.now()
    // Sanitize filename: remove special characters, spaces, and non-ASCII characters
    const sanitizedFileName = file.name
      .normalize('NFD') // Normalize Unicode characters
      .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
      .replace(/[^\x00-\x7F]/g, '') // Remove non-ASCII characters
      .replace(/[^a-zA-Z0-9.-]/g, '_') // Replace special chars with underscore
      .replace(/_{2,}/g, '_') // Replace multiple underscores with single
      .replace(/^_|_$/g, '') // Remove leading/trailing underscores
    
    const fileName = `${effectiveUserId}/${timestamp}-${sanitizedFileName}`

    // Upload file to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('study-materials')
      .upload(fileName, file, {
        cacheControl: '3600',
        upsert: false
      })

    if (uploadError) {
      console.error('Storage upload error:', uploadError)
      console.error('Upload error details:', {
        message: uploadError.message,
        name: uploadError.name
      })
      
      // Check if bucket exists
      if (uploadError.message?.includes('not found') || uploadError.message?.includes('404')) {
        return NextResponse.json(
          { 
            error: 'Storage bucket not configured',
            details: 'Please create the "study-materials" bucket in Supabase Storage with public access'
          },
          { status: 500 }
        )
      }
      
      return NextResponse.json(
        { 
          error: 'Failed to upload file',
          details: uploadError.message
        },
        { status: 500 }
      )
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from('study-materials')
      .getPublicUrl(fileName)

    // Ensure user exists in public.users table
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('id', effectiveUserId)
      .single()

    if (!existingUser) {
      // Create user in public.users table
      const { error: createUserError } = await supabaseAdmin
        .from('users')
        .insert({
          id: effectiveUserId,
          name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'User',
          email: user.email || '',
          exam_type: null,
          language: 'English',
          created_at: new Date().toISOString()
        })

      if (createUserError) {
        console.error('Error creating user record:', createUserError)
        // Continue anyway - user might already exist due to race condition
      } else {
        console.log('User record created successfully for:', effectiveUserId)
      }
    }

    // Get user's exam type and language preferences for the material
    const { data: userData } = await supabaseAdmin
      .from('users')
      .select('exam_type, selected_exam, preferred_language, language')
      .eq('id', effectiveUserId)
      .single()
    
    const userExamType = userData?.exam_type || userData?.selected_exam || 'Other'
    const userLanguage = userData?.preferred_language || userData?.language || 'English'
    
    // Map language to OCR language code
    const languageMap: Record<string, string> = {
      'English': 'eng',
      'Hindi': 'hin',
      'Bengali': 'ben',
      'Tamil': 'tam',
      'Telugu': 'tel',
      'Other': 'eng'
    }
    
    // For Hindi or mixed content, use both languages
    const ocrLanguage = userLanguage === 'Hindi' ? 'hin+eng' : languageMap[userLanguage] || 'eng'
    
    // Get exam and topic from form data, fallback to user preferences
    const formTopic = formData.get('topic') as string
    
    // Use form exam_type if provided, otherwise use user's selected exam
    const finalExam = formExamType || userExamType
    
    // Topic: Use form value if provided, else try to infer from filename, else "General"
    let finalTopic = formTopic || 'General'
    
    // Smart topic inference from filename if not provided
    if (!formTopic && file.name) {
      const fileName = file.name.toLowerCase()
      const topicKeywords: Record<string, string> = {
        'physics': 'Physics',
        'chemistry': 'Chemistry',
        'math': 'Mathematics',
        'biology': 'Biology',
        'history': 'History',
        'geography': 'Geography',
        'polity': 'Polity',
        'economy': 'Economy',
        'economics': 'Economy',
        'science': 'Science',
        'reasoning': 'Reasoning',
        'english': 'English',
        'quant': 'Quantitative Aptitude'
      }
      
      for (const [keyword, topic] of Object.entries(topicKeywords)) {
        if (fileName.includes(keyword)) {
          finalTopic = topic
          console.log(`Auto-detected topic "${topic}" from filename: ${file.name}`)
          break
        }
      }
    }
    
    // Create initial material record
    const { data: material, error: materialError } = await supabaseAdmin
      .from('study_materials')
      .insert({
        user_id: effectiveUserId,
        exam_type: finalExam,
        topic: finalTopic,
        material_type: materialType,
        file_url: urlData.publicUrl,
        file_type: file.type,
        file_size: file.size,
        processing_status: 'processing'
      })
      .select()
      .single()

    if (materialError || !material) {
      console.error('Error creating material record:', materialError)
      
      // Cleanup: delete uploaded file
      await supabase.storage
        .from('study-materials')
        .remove([fileName])

      return NextResponse.json(
        { 
          error: 'Failed to create material record',
          details: materialError?.message || 'Unknown error',
          code: materialError?.code
        },
        { status: 500 }
      )
    }

    const materialId = material.id; // Store material ID for catch block
    const topicFromForm = finalTopic;

    // Process file for text extraction using LangChain
    try {
      console.log('Starting text extraction with LangChain...')
      
      // Convert File to Buffer for processing
      const fileBuffer = Buffer.from(await file.arrayBuffer())
      
      // Different extraction strategy based on material type
      let rawText: string;
      let chunks: any[];
      
      if (materialType === 'syllabus') {
        console.log(`Processing syllabus: ${file.name} (${file.type})`)
        console.log('📋 Using Gemini-based topic extraction for syllabus')
        
        // For syllabus: Extract raw text only, no chunking yet
        // We'll organize by topics after AI extraction
        const { rawText: text } = await extractAndChunkPDF(fileBuffer, CHUNK_STRATEGIES.MEDIUM);
        rawText = text;
        chunks = []; // Will create topic-based chunks later
        
        console.log(`✓ Extracted ${rawText.length} chars (full syllabus text)`)
        console.log('  Topics will be extracted with Gemini AI')
      } else {
        console.log(`Processing ${materialType}: ${file.name} (${file.type})`)
        console.log('📦 Using uniform chunk-based extraction')
        
        // For notes/materials: Use standard chunking for semantic search
        const result = await extractAndChunkPDF(fileBuffer, CHUNK_STRATEGIES.MEDIUM);
        rawText = result.rawText;
        chunks = result.chunks;
        
        console.log(`✓ Extracted ${rawText.length} chars → ${chunks.length} uniform chunks`)
        console.log(`  Chunk strategy: ${CHUNK_STRATEGIES.MEDIUM.size} chars with ${CHUNK_STRATEGIES.MEDIUM.overlap} overlap`)
      }
      
      // Create a compatible extraction result for existing code
      const extractionResult = {
        success: true,
        text: rawText,
        chunks: chunks.map((chunk, idx) => ({
          content: chunk.text,
          metadata: {
            source: fileName,
            chunkIndex: idx,
            page: Math.floor(chunk.start_char / 3000) + 1
          }
        })),
        parsedQuestions: [], // No question parsing for generic PDFs
        metadata: {
          extractionMethod: 'text' as const,
          wordCount: rawText.split(/\s+/).length,
          characterCount: rawText.length,
          pageCount: Math.ceil(rawText.length / 3000), // Estimate
          questionsExtracted: 0
        }
      };

      // Sanitize text for database storage
      const cleanText = sanitizeTextForDB(extractionResult.text)
      
      // Check if document might be scanned
      const likelyScanned = isLikelyScanned(extractionResult, file.size)
      
      // Special handling for syllabus files - extract topics
      let syllabusTopics: string[] = [];
      let syllabusSubtopics: Record<string, string[]> = {};
      let syllabusSections: string[] = [];
      
      if (materialType === 'syllabus') {
        console.log('🎯 Detected syllabus file - extracting topics with AI...');
        
        try {
          const syllabusExtraction = await extractSyllabusTopics(rawText, finalExam);
          
          if (syllabusExtraction.success && syllabusExtraction.topics.length > 0) {
            syllabusTopics = syllabusExtraction.topics;
            syllabusSubtopics = syllabusExtraction.subtopics || {};
            syllabusSections = syllabusExtraction.sections || [];
            console.log(`✅ AI extracted ${syllabusTopics.length} topics from syllabus`);
            console.log('Sample topics:', syllabusTopics.slice(0, 5));
            
            // For syllabus: Store ONLY topic names as chunks (not full text excerpts)
            console.log('📚 Creating topic name chunks for syllabus...');
            chunks = syllabusTopics.map((topic, idx) => {
              // Add subtopics if available for richer context
              const subtopicsList = syllabusSubtopics[topic] || [];
              const topicWithSubtopics = subtopicsList.length > 0
                ? `${topic}\nSubtopics: ${subtopicsList.join(', ')}`
                : topic;
              
              return {
                text: topicWithSubtopics,
                index: idx,
                start_char: 0,
                end_char: topicWithSubtopics.length,
                char_count: topicWithSubtopics.length,
                word_count: topicWithSubtopics.split(/\s+/).length
              };
            });
            
            console.log(`✓ Created ${chunks.length} topic chunks (avg: ${Math.round(chunks.reduce((sum, c) => sum + c.char_count, 0) / chunks.length)} chars per topic)`);
          } else {
            console.log('⚠️ AI extraction failed or returned no topics, using pattern matching fallback...');
            console.log('AI extraction error:', syllabusExtraction.error);
            syllabusTopics = extractTopicsWithPatterns(rawText, finalExam);
            console.log(`✅ Pattern matching extracted ${syllabusTopics.length} topics`);
            
            // Store only topic names (no full text extraction)
            chunks = syllabusTopics.map((topic, idx) => ({
              text: topic,
              index: idx,
              start_char: 0,
              end_char: topic.length,
              char_count: topic.length,
              word_count: topic.split(/\s+/).length
            }));
          }
        } catch (error: any) {
          console.error('❌ Topic extraction error (will use fallback):', error.message || error);
          // Use pattern matching as fallback - THIS MUST NOT FAIL
          try {
            syllabusTopics = extractTopicsWithPatterns(rawText, finalExam);
            console.log(`✅ Fallback pattern matching extracted ${syllabusTopics.length} topics`);
          } catch (patternError) {
            console.error('❌ Pattern matching also failed, using empty topics');
            syllabusTopics = [];
          }
          
          // Store only topic names (no full text extraction)
          chunks = syllabusTopics.map((topic, idx) => ({
            text: topic,
            index: idx,
            start_char: 0,
            end_char: topic.length,
            char_count: topic.length,
            word_count: topic.split(/\s+/).length
          }));
        }
      }
      
      // Prepare structured content for storage with parsed questions
      const structuredContent = {
        document_type: materialType === 'syllabus' ? 'syllabus' : 'document',
        extraction_method: extractionResult.metadata.extractionMethod,
        likely_scanned: likelyScanned,
        is_syllabus: materialType === 'syllabus',
        syllabus_data: materialType === 'syllabus' ? {
          topics: syllabusTopics,
          subtopics: syllabusSubtopics,
          sections: syllabusSections,
          extracted_at: new Date().toISOString()
        } : undefined,
        chunks: extractionResult.chunks.map(chunk => ({
          content: sanitizeTextForDB(chunk.content),
          metadata: chunk.metadata
        })),
        parsed_questions: extractionResult.parsedQuestions || [],
        metadata: {
          processing_method: extractionResult.metadata.extractionMethod,
          word_count: extractionResult.metadata.wordCount,
          character_count: extractionResult.metadata.characterCount,
          page_count: extractionResult.metadata.pageCount,
          chunk_count: extractionResult.chunks.length,
          questions_extracted: extractionResult.metadata.questionsExtracted || 0
        },
        content: {
          full_text: cleanText,
          chunks: extractionResult.chunks.map(c => sanitizeTextForDB(c.content)),
          questions: extractionResult.parsedQuestions || []
        },
        topics: [topicFromForm]
      }
      
      // Additional safety: recursively sanitize all text in structured content
      function sanitizeStructuredContent(obj: any): any {
        if (typeof obj === 'string') {
          return sanitizeTextForDB(obj) || ''
        }
        if (Array.isArray(obj)) {
          return obj.map(item => sanitizeStructuredContent(item))
        }
        if (obj && typeof obj === 'object') {
          const sanitized: any = {}
          for (const [key, value] of Object.entries(obj)) {
            sanitized[key] = sanitizeStructuredContent(value)
          }
          return sanitized
        }
        return obj
      }
      
      const cleanStructuredContent = sanitizeStructuredContent(structuredContent)
      
      console.log(
        `Storing ${extractionResult.text.length} chars, ${extractionResult.chunks.length} extracted chunks, ` +
        `${extractionResult.parsedQuestions?.length || 0} structured questions`
      );
      
      // Update material with extracted content (both text and structured JSON)
      const updateData: any = {
        extracted_text: cleanText,
        structured_content: cleanStructuredContent,
        ocr_confidence: 100, // LangChain extraction is deterministic
        processing_status: 'processing'
      }
      
      // Update material (without embedding first)
      const { error: updateError } = await supabaseAdmin
        .from('study_materials')
        .update(updateData)
        .eq('id', material.id)

      if (updateError) {
        console.error('Error updating material with OCR result:', updateError)
        throw new Error(`Could not save extracted document content: ${updateError.message}`)
      }
      
      // Store individual chunks with embeddings in document_chunks table
      // For syllabus: Skip embeddings (topics are just for selection, not search)
      // For notes/materials: Generate embeddings for semantic search
      const skipEmbeddings = materialType === 'syllabus';
      
      if (skipEmbeddings) {
        console.log(`📦 Storing ${chunks.length} syllabus topics (no embeddings needed)...`);
      } else {
        console.log(`📦 Storing ${chunks.length} chunks with embeddings (optimized batch processing)...`);
      }
      
      let chunksStored = 0;
      
      try {
        if (skipEmbeddings) {
          // For syllabus topics: Batch insert without embeddings (fast)
          const chunkRecords = chunks.map((chunk, i) => ({
            user_id: effectiveUserId,
            material_id: material.id,
            chunk_index: chunk.index,
            chunk_text: sanitizeChunkText(chunk.text),
            embedding: null,
            start_char: chunk.start_char,
            end_char: chunk.end_char,
            char_count: chunk.char_count,
            word_count: chunk.word_count
          }));
          
          const { error: batchError } = await supabaseAdmin
            .from('document_chunks')
            .insert(chunkRecords);
          
          if (batchError) {
            console.error('❌ Batch insert failed:', batchError);
            throw new Error(`Could not store syllabus topics: ${batchError.message}`);
          } else {
            chunksStored = chunks.length;
            console.log(`✓ Batch inserted ${chunksStored} syllabus topics`);
          }
        } else {
          // For notes/materials: Generate embeddings in parallel batches, then batch insert
          console.log(`🚀 Generating ${chunks.length} embeddings in parallel...`);
          const startTime = Date.now();
          if (chunks.length === 0) {
            throw new Error('No document chunks were produced for embedding.');
          }

          const chunkTexts = chunks.map(chunk => sanitizeChunkText(chunk.text));
          const chunkEmbeddings = await generateEmbeddings(chunkTexts);
          if (
            chunkEmbeddings.length !== chunks.length ||
            chunkEmbeddings.some(embedding => embedding.length !== 768)
          ) {
            throw new Error('Chunk embedding generation returned incomplete or invalid vectors.');
          }

          const embeddingTime = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`✓ All embeddings generated in ${embeddingTime}s`);

          const chunkRecords = chunks.map((chunk, i) => ({
            user_id: effectiveUserId,
            material_id: material.id,
            chunk_index: chunk.index,
            chunk_text: sanitizeChunkText(chunk.text),
            embedding: `[${chunkEmbeddings[i].join(',')}]`,
            start_char: chunk.start_char,
            end_char: chunk.end_char,
            char_count: chunk.char_count,
            word_count: chunk.word_count
          }));

          const insertBatchSize = 20;
          for (let i = 0; i < chunkRecords.length; i += insertBatchSize) {
            const batch = chunkRecords.slice(i, i + insertBatchSize);
            const { error: insertError } = await supabaseAdmin
              .from('document_chunks')
              .insert(batch);

            if (insertError) {
              console.error(`❌ Insert batch ${Math.floor(i / insertBatchSize) + 1} failed:`, insertError);
              throw new Error(`Could not store document chunks: ${insertError.message}`);
            }

            chunksStored += batch.length;
          }

          const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`✓ Successfully stored ${chunksStored}/${chunks.length} chunks in ${totalTime}s`);
        }

        if (chunksStored !== chunks.length) {
          throw new Error(`Only ${chunksStored} of ${chunks.length} document chunks were stored.`);
        }
      } catch (chunkError) {
        console.error('❌ Error storing chunks:', chunkError);
        throw chunkError;
      }

      const { error: completionError } = await supabaseAdmin
        .from('study_materials')
        .update({ processing_status: 'completed' })
        .eq('id', material.id)

      if (completionError) {
        throw new Error(`Could not mark document processing complete: ${completionError.message}`);
      }

      // Update user_progress - increment material uploads for this topic
      try {
        const topicFromForm = formData.get('topic') as string || 'General';
        
        // Check if progress record exists
        const { data: existingProgress } = await supabaseAdmin
          .from('user_progress')
          .select('*')
          .eq('user_id', effectiveUserId)
          .eq('exam_type', userExamType)
          .eq('topic', topicFromForm)
          .single();

        if (existingProgress) {
          // Update existing record
          await supabaseAdmin
            .from('user_progress')
            .update({
              updated_at: new Date().toISOString()
            })
            .eq('user_id', effectiveUserId)
            .eq('exam_type', userExamType)
            .eq('topic', topicFromForm);
        } else {
          // Create new progress record
          await supabaseAdmin
            .from('user_progress')
            .insert({
              user_id: effectiveUserId,
              exam_type: userExamType,
              topic: topicFromForm,
              tests_attempted: 0,
              average_score: 0,
              highest_score: 0,
              lowest_score: 0,
              total_time_spent: 0,
              accuracy_rate: 0,
              strong_topics: [],
              weak_topics: []
            });
        }
      } catch (progressError) {
        console.error('Error updating user progress:', progressError);
        // Don't fail the request
      }

      return NextResponse.json({
        success: true,
        embeddingGenerated: materialType !== 'syllabus' && chunksStored > 0,
        isSyllabus: materialType === 'syllabus',
        syllabusTopics: materialType === 'syllabus' ? syllabusTopics : undefined,
        material: {
          id: material.id,
          filename: file.name,
          fileType: material.file_type,
          fileSize: material.file_size,
          materialType: materialType,
          extractedText: extractionResult.text.substring(0, 500), // Return preview only (full text in DB)
          fullTextLength: extractionResult.text.length, // Show actual stored length
          confidence: 100,
          processingStatus: 'completed',
          extractionMethod: extractionResult.metadata.extractionMethod,
          chunkCount: extractionResult.chunks.length,
          questionsExtracted: extractionResult.parsedQuestions?.length || 0,
          topic: topicFromForm,
          quality: {
            score: 100,
            grade: 'excellent',
            usable: true,
            issues: [],
            recommendations: []
          }
        }
      })

    } catch (ocrError) {
      console.error('OCR processing error:', ocrError)
      
      // Determine if this is a scanned PDF issue
      const isScannedPDFError = ocrError instanceof Error && 
        (ocrError.message.includes('scanned images') || 
         ocrError.message.includes('OCR') ||
         ocrError.message.includes('too short or empty'));
      
      const errorMessage = isScannedPDFError
        ? 'This PDF appears to contain scanned images. Please upload a PDF with selectable text, or try converting your scanned PDF to text using an OCR tool first.'
        : ocrError instanceof Error ? ocrError.message : 'Unknown extraction error';

      const isChunkProcessingError = /embedding|chunk|document processing complete/i.test(errorMessage);

      const { error: chunkCleanupError } = await supabaseAdmin
        .from('document_chunks')
        .delete()
        .eq('material_id', materialId)

      if (chunkCleanupError) {
        console.error('Failed to clean up incomplete document chunks:', chunkCleanupError);
      }
      
      // Update status to failed
      const { error: statusUpdateError } = await supabaseAdmin
        .from('study_materials')
        .update({ 
          processing_status: 'failed',
          extracted_text: `ERROR: ${errorMessage}`
        })
        .eq('id', materialId)

      if (statusUpdateError) {
        console.error('Failed to mark material processing as failed:', statusUpdateError);
      }

      return NextResponse.json({
        success: false,
        error: isChunkProcessingError ? 'Document processing failed' : 'Text extraction failed',
        details: errorMessage,
        isScannedPDF: isScannedPDFError,
        material: {
          id: materialId,
          filename: file.name,
          processingStatus: 'failed'
        },
        suggestion: isScannedPDFError 
          ? 'Try using a PDF with selectable text, or convert your scanned document using an online OCR tool like https://www.onlineocr.net/ or Adobe Acrobat.'
          : 'Please try a different file format or check if the PDF is corrupted.'
      }, { status: isChunkProcessingError ? 500 : 400 })
    }

  } catch (error: any) {
    console.error('Error in upload API:', error)
    
    // Provide more specific error messages
    let errorMessage = 'Internal server error';
    let statusCode = 500;
    
    if (error.status === 429 || error.message?.includes('429') || error.message?.includes('quota') || error.message?.includes('rate limit')) {
      errorMessage = 'AI service is temporarily busy. Please wait a minute and try again.';
      statusCode = 429;
    } else if (error.message?.includes('GEMINI') || error.message?.includes('Gemini')) {
      errorMessage = 'AI processing failed. Please try again.';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    return NextResponse.json(
      { error: errorMessage, details: error.message || 'Unknown error' },
      { status: statusCode }
    )
  }
}