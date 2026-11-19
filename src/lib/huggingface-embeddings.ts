/**
 * HuggingFace Embeddings Service
 * Uses local Transformers.js inference with the same model for upload and search.
 */

import { env, pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';

const EMBEDDING_MODEL = 'Xenova/all-mpnet-base-v2';
const EMBEDDING_DIMENSIONS = 768;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = false;
env.backends.onnx.wasm.numThreads = 1;

let embeddingPipeline: FeatureExtractionPipeline | null = null;
let embeddingPipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  if (!embeddingPipelinePromise) {
    console.log(`Loading local embedding model ${EMBEDDING_MODEL}...`);
    embeddingPipelinePromise = pipeline('feature-extraction', EMBEDDING_MODEL, {
      quantized: true
    }).then((model) => {
      embeddingPipeline = model;
      console.log(`Local embedding model ${EMBEDDING_MODEL} loaded`);
      return model;
    }).catch((error: unknown) => {
      embeddingPipelinePromise = null;
      const message = error instanceof Error ? error.message : String(error);
      console.error('Local embedding model initialization failed:', error);
      throw new Error(`Local embedding model initialization failed: ${message}`);
    });
  }

  return embeddingPipelinePromise;
}

/**
 * Generate a 768-dimensional embedding locally.
 * @param text - Text to embed (max ~512 tokens recommended)
 * @param retries - Number of retry attempts (default: 3)
 * @param silent - Suppress logs for batch processing (default: false)
 * @returns 768-dimensional embedding vector
 */
export async function generateEmbedding(text: string, retries: number = 3, silent: boolean = false): Promise<number[]> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Text cannot be empty');
  }

  const truncatedText = text.slice(0, 8000);
  
  if (!silent) {
    console.log(`Generating local embedding (${truncatedText.length} chars)...`);
  }
  
  let lastError: Error | null = null;
  const maxAttempts = Number.isFinite(retries) ? Math.max(1, Math.floor(retries)) : 3;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const model = await getEmbeddingPipeline();
      const output = await model(truncatedText, {
        pooling: 'mean',
        normalize: true
      });
      const embedding = Array.from(output.data);

      if (embedding.length !== EMBEDDING_DIMENSIONS || embedding.some(value => !Number.isFinite(value))) {
        throw new Error(
          `Invalid embedding output: expected ${EMBEDDING_DIMENSIONS} finite values, received ${embedding.length}`
        );
      }

      if (!silent) {
        console.log(`Local embedding generated (${embedding.length} dimensions)`);
      }

      return embedding;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!silent) {
        console.warn(`Local embedding attempt ${attempt}/${maxAttempts} failed:`, lastError.message);
      }

      if (attempt < maxAttempts) {
        const waitTime = Math.min(500 * Math.pow(2, attempt - 1), 2000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  console.error('All local embedding attempts failed');
  throw new Error(
    `Failed to generate local embedding after ${maxAttempts} attempts: ${lastError?.message || 'Unknown error'}`
  );
}

/**
 * Generate embeddings for multiple texts using bounded local inference batches.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (!texts || texts.length === 0) {
    throw new Error('Texts array cannot be empty');
  }

  console.log(`Generating ${texts.length} local embeddings in batches...`);

  const embeddings: number[][] = [];
  const batchSize = 4;
  const startTime = Date.now();

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(texts.length / batchSize);
    
    try {
      const batchEmbeddings = await Promise.all(
        batch.map(text => generateEmbedding(text, 2, true))
      );
      
      embeddings.push(...batchEmbeddings);
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`Embedding batch ${batchNum}/${totalBatches} complete (${embeddings.length}/${texts.length} in ${elapsed}s)`);
    } catch (error: unknown) {
      console.error(`❌ Batch ${batchNum} failed:`, error);
      throw new Error(
        `Failed at batch ${batchNum}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Generated all ${embeddings.length} embeddings in ${totalTime}s`);
  return embeddings;
}

/**
 * Format study material for embedding generation
 * Combines topic + key questions for semantic representation
 */
export function formatMaterialForEmbedding(
  topic: string, 
  questions: Array<{ question: string; options?: string[] }>
): string {
  const questionTexts = questions
    .slice(0, 3) // Top 3 questions
    .map(q => q.question)
    .join(' ');
  
  return `Topic: ${topic}. ${questionTexts}`.slice(0, 2000);
}

/**
 * Calculate cosine similarity between two embedding vectors
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must have same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Find most similar items from a list based on embedding similarity
 */
export function findMostSimilar(
  queryEmbedding: number[],
  items: Array<{ embedding: number[]; data: any }>,
  topK: number = 5
): Array<{ similarity: number; data: any }> {
  const similarities = items.map(item => ({
    similarity: cosineSimilarity(queryEmbedding, item.embedding),
    data: item.data
  }));

  return similarities
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

/**
 * Extract representative sentences and frequent terms without a hosted inference call.
 */
export async function extractKeyContent(text: string, maxLength: number = 1900): Promise<string> {
  if (!text || text.trim().length === 0) {
    throw new Error('Text cannot be empty');
  }

  if (text.length <= maxLength) {
    return text;
  }

  const stopWords = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was',
    'one', 'our', 'out', 'has', 'have', 'this', 'that', 'with', 'from', 'they', 'will'
  ]);
  const wordFrequencies = new Map<string, number>();
  const words = text.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  for (const word of words) {
    if (!stopWords.has(word)) {
      wordFrequencies.set(word, (wordFrequencies.get(word) || 0) + 1);
    }
  }

  const sentences = (text.match(/[^.!?\n]+[.!?]?/g) || [])
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 30);
  const scoredSentences = sentences.map((sentence, index) => {
    const sentenceWords = sentence.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    const score = sentenceWords.reduce((total, word) => total + (wordFrequencies.get(word) || 0), 0);
    return { sentence, index, score };
  });
  const selectedSentences: Array<{ sentence: string; index: number; score: number }> = [];

  for (const item of scoredSentences.sort((a, b) => b.score - a.score)) {
    const candidate = [...selectedSentences, item].map(({ sentence }) => sentence).join(' ');
    if (candidate.length > maxLength) {
      continue;
    }
    selectedSentences.push(item);
  }

  const representativeText = selectedSentences
    .sort((a, b) => a.index - b.index)
    .map(({ sentence }) => sentence)
    .join(' ');
  const frequentTerms = Array.from(wordFrequencies.entries())
    .filter(([, frequency]) => frequency > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80)
    .map(([word]) => word)
    .join(' ');

  return `${representativeText} ${frequentTerms}`.trim().slice(0, maxLength);
}
