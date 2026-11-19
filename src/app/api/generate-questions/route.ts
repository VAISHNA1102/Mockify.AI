import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { generateQuestionsFromContent, type GeneratedQuestion } from '@/lib/gemini';
import { generateEmbedding } from '@/lib/huggingface-embeddings';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RetrievedChunk = {
  material_id: string;
  chunk_text: string;
  similarity: number;
  metadata?: {
    material_topic?: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRetrievedChunk(value: unknown): RetrievedChunk | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.material_id !== 'string' ||
    typeof value.chunk_text !== 'string' ||
    typeof value.similarity !== 'number' ||
    !Number.isFinite(value.similarity)
  ) {
    return null;
  }

  const metadata = isRecord(value.metadata) && typeof value.metadata.material_topic === 'string'
    ? { material_topic: value.metadata.material_topic }
    : undefined;

  return {
    material_id: value.material_id,
    chunk_text: value.chunk_text,
    similarity: value.similarity,
    metadata
  };
}

function parseRetrievedChunks(value: unknown): RetrievedChunk[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(toRetrievedChunk)
    .filter((chunk): chunk is RetrievedChunk => chunk !== null);
}

export async function POST(request: NextRequest) {
  try {
    let authenticatedUserId: string | null = null;
    const authHeader = request.headers.get('authorization');

    if (authHeader) {
      const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!tokenMatch) {
        return NextResponse.json({ error: 'Invalid authorization header' }, { status: 401 });
      }

      const { data: { user }, error: authError } = await supabase.auth.getUser(tokenMatch[1]);
      if (authError || !user) {
        return NextResponse.json({ error: 'Authentication required. Please log in again.' }, { status: 401 });
      }
      authenticatedUserId = user.id;
    } else {
      const sessionClient = await createServerSupabaseClient();
      const { data: { user }, error: authError } = await sessionClient.auth.getUser();
      if (authError || !user) {
        return NextResponse.json({ error: 'Authentication required. Please log in.' }, { status: 401 });
      }
      authenticatedUserId = user.id;
    }

    const body: unknown = await request.json();
    if (!isRecord(body)) {
      return NextResponse.json({ error: 'A valid request body is required.' }, { status: 400 });
    }

    const rawMaterialIds = body.materialIds;
    if (!Array.isArray(rawMaterialIds) || rawMaterialIds.length === 0) {
      return NextResponse.json(
        { error: 'Select at least one processed study material before generating questions.' },
        { status: 400 }
      );
    }

    const materialIds: string[] = [];
    for (const id of rawMaterialIds) {
      if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
        return NextResponse.json(
          { error: 'One or more selected study material IDs are invalid. Please select your PDF again.' },
          { status: 400 }
        );
      }
      const normalizedId = id.toLowerCase();
      if (!materialIds.includes(normalizedId)) {
        materialIds.push(normalizedId);
      }
    }

    const testConfig = body.testConfig;
    if (!isRecord(testConfig)) {
      return NextResponse.json({ error: 'Test configuration is required.' }, { status: 400 });
    }

    const examType = typeof testConfig.examType === 'string' ? testConfig.examType.trim() : '';
    const difficultyValue = typeof testConfig.difficulty === 'string'
      ? testConfig.difficulty.toLowerCase()
      : '';
    const difficulty = difficultyValue === 'easy' || difficultyValue === 'medium' || difficultyValue === 'hard'
      ? difficultyValue
      : null;
    const questionCount = Number(testConfig.questionCount);
    const topics = Array.isArray(testConfig.topics)
      ? testConfig.topics.filter((topic): topic is string => typeof topic === 'string' && topic.trim().length > 0)
        .map(topic => topic.trim())
      : [];

    if (
      !examType ||
      !difficulty ||
      !Number.isInteger(questionCount) ||
      questionCount < 1 ||
      questionCount > 50
    ) {
      return NextResponse.json(
        { error: 'Test configuration must include an exam type, a valid difficulty, and 1-50 questions.' },
        { status: 400 }
      );
    }

    const { data: selectedMaterials, error: materialLookupError } = await supabase
      .from('study_materials')
      .select('id, user_id, processing_status, topic')
      .in('id', materialIds);

    if (materialLookupError) {
      console.error('Selected material lookup failed:', materialLookupError);
      return NextResponse.json(
        { error: 'Could not verify the selected study materials. Please try again.' },
        { status: 500 }
      );
    }

    const materialsById = new Map((selectedMaterials || []).map(material => [material.id.toLowerCase(), material]));
    const inaccessibleIds = materialIds.filter(id => {
      const material = materialsById.get(id);
      return !material || material.user_id !== authenticatedUserId;
    });

    if (inaccessibleIds.length > 0) {
      console.warn('Selected materials are missing or owned by another user:', {
        count: inaccessibleIds.length,
        ids: inaccessibleIds.map(id => id.slice(0, 8))
      });
      return NextResponse.json(
        { error: 'One or more selected study materials are unavailable or have not finished processing.' },
        { status: 403 }
      );
    }

    const incompleteMaterials = (selectedMaterials || []).filter(material =>
      materialIds.includes(material.id.toLowerCase()) &&
      material.user_id === authenticatedUserId &&
      material.processing_status !== 'completed'
    );

    if (incompleteMaterials.length > 0) {
      console.warn('Selected materials are not completed:', incompleteMaterials.map(material => ({
        id: material.id.slice(0, 8),
        status: material.processing_status
      })));
      return NextResponse.json(
        { error: 'One or more selected study materials are still processing or failed. Select a completed PDF.' },
        { status: 409 }
      );
    }

    const searchPlans: Array<{ materialId: string; queryEmbedding: number[] }> = [];
    try {
      for (const material of selectedMaterials || []) {
        const searchQuery = [
          examType,
          material.topic,
          ...topics
        ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
          .join(' ');
        const queryEmbedding = await generateEmbedding(searchQuery);
        searchPlans.push({ materialId: material.id, queryEmbedding });
        console.info('[question-generation] Query embedding ready:', {
          materialId: material.id.slice(0, 8),
          dimensions: queryEmbedding.length,
          queryLength: searchQuery.length
        });
      }
    } catch (embeddingError) {
      console.error('Question-search embedding generation failed:', embeddingError);
      return NextResponse.json(
        { error: 'Could not create a search embedding. Please try again after the local model is available.' },
        { status: 503 }
      );
    }

    const selectedMaterialIds = new Set(materialIds);
    const matchThreshold = 0.05;
    const searchResults = await Promise.all(searchPlans.map(async plan => ({
      materialId: plan.materialId,
      result: await supabase.rpc('search_similar_chunks', {
        query_embedding: `[${plan.queryEmbedding.join(',')}]`,
        match_threshold: matchThreshold,
        match_count: 30,
        filter_user_id: authenticatedUserId,
        filter_material_id: plan.materialId
      })
    })));

    const failedSearch = searchResults.find(search => search.result.error);
    if (failedSearch?.result.error) {
      console.error('Selected PDF chunk retrieval failed:', {
        materialId: failedSearch.materialId.slice(0, 8),
        error: failedSearch.result.error
      });
      return NextResponse.json(
        { error: 'Could not retrieve content from the selected PDF. Please try again.' },
        { status: 503 }
      );
    }

    for (const search of searchResults) {
      const scores = parseRetrievedChunks(search.result.data)
        .map(chunk => chunk.similarity);
      console.info('[question-generation] Material-scoped vector search:', {
        materialId: search.materialId.slice(0, 8),
        matchThreshold,
        candidates: scores.length,
        bestSimilarity: scores.length > 0 ? Math.max(...scores).toFixed(4) : null,
        similarityRange: scores.length > 0
          ? [Math.min(...scores).toFixed(4), Math.max(...scores).toFixed(4)]
          : null
      });
    }

    const relevantChunks: RetrievedChunk[] = searchResults
      .flatMap(search => parseRetrievedChunks(search.result.data))
      .filter(chunk => selectedMaterialIds.has(chunk.material_id))
      .filter(chunk => chunk.chunk_text.trim().length > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 30);

    if (relevantChunks.length === 0) {
      const diagnosticResults = await Promise.all(searchPlans.map(async plan => {
        const { data, error } = await supabase.rpc('search_similar_chunks', {
          query_embedding: `[${plan.queryEmbedding.join(',')}]`,
          match_threshold: -1,
          match_count: 5,
          filter_user_id: authenticatedUserId,
          filter_material_id: plan.materialId
        });
        const scores = parseRetrievedChunks(data)
          .map(chunk => chunk.similarity);

        return {
          materialId: plan.materialId.slice(0, 8),
          error: error?.message,
          candidateCount: scores.length,
          bestSimilarity: scores.length > 0 ? Math.max(...scores).toFixed(4) : null,
          similarityRange: scores.length > 0
            ? [Math.min(...scores).toFixed(4), Math.max(...scores).toFixed(4)]
            : null
        };
      }));
      console.warn('[question-generation] No candidates met the relevance threshold:', {
        matchThreshold,
        diagnostics: diagnosticResults
      });
      return NextResponse.json(
        { error: 'No relevant content was found in the selected PDF. Upload or select a PDF that covers these topics.' },
        { status: 422 }
      );
    }

    const retrievedTextLength = relevantChunks.reduce((total, chunk) => total + chunk.chunk_text.trim().length, 0);
    if (retrievedTextLength < 100) {
      return NextResponse.json(
        { error: 'The selected PDF does not contain enough retrieved content for a reliable test. Select a more relevant PDF.' },
        { status: 422 }
      );
    }

    const combinedContent = relevantChunks
      .map((chunk, index) => {
        const materialTopic = chunk.metadata?.material_topic?.trim() || 'Selected PDF';
        return `[PDF context ${index + 1}] (${materialTopic})\n${chunk.chunk_text.trim()}`;
      })
      .filter(section => section.length > 0)
      .join('\n\n---\n\n');

    let questions: GeneratedQuestion[];
    try {
      questions = await generateQuestionsFromContent({
        content: combinedContent,
        examType,
        difficulty,
        questionCount,
        topics
      });
    } catch (generationError) {
      console.error('Gemini question generation failed:', generationError);
      const errorMessage = generationError instanceof Error ? generationError.message : '';
      if (errorMessage.includes('supported questions')) {
        return NextResponse.json(
          { error: 'The selected PDF context is insufficient for the requested number of questions. Select more relevant material or request fewer questions.' },
          { status: 422 }
        );
      }
      return NextResponse.json(
        { error: 'Question generation failed for the selected PDF context. Please try again.' },
        { status: 502 }
      );
    }

    if (!Array.isArray(questions) || questions.length !== questionCount) {
      console.error(`Gemini returned ${questions?.length || 0} questions; expected ${questionCount}.`);
      return NextResponse.json(
        { error: 'The AI could not produce the requested number of valid PDF-grounded questions. Try fewer questions or select a more relevant PDF.' },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Questions generated successfully',
      test_id: `pdf-test-${Date.now()}`,
      questions,
      metadata: {
        exam_type: examType,
        difficulty,
        question_count: questions.length,
        generated_at: new Date().toISOString(),
        chunks_used: relevantChunks.length,
        content_length: combinedContent.length,
        average_similarity: (
          relevantChunks.reduce((total, chunk) => total + chunk.similarity, 0) /
          relevantChunks.length * 100
        ).toFixed(1) + '%',
        materials_used: materialIds.length
      }
    });
  } catch (error: unknown) {
    console.error('Error in generate questions API:', error);
    return NextResponse.json(
      { error: 'Question generation request failed. Please try again.' },
      { status: 500 }
    );
  }
}
