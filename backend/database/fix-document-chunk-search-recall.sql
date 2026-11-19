-- Improve recall for per-material searches without changing tables or stored data.
-- The current document_chunks IVFFlat index is configured with 100 lists.
CREATE OR REPLACE FUNCTION public.search_similar_chunks(
    query_embedding vector(768),
    match_threshold float DEFAULT 0.5,
    match_count int DEFAULT 10,
    filter_user_id uuid DEFAULT NULL,
    filter_material_id uuid DEFAULT NULL
)
RETURNS TABLE (
    chunk_id uuid,
    material_id uuid,
    chunk_index int,
    chunk_text text,
    similarity float,
    metadata jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
    IF filter_material_id IS NOT NULL THEN
        PERFORM set_config('ivfflat.probes', '100', true);
    END IF;

    RETURN QUERY
    SELECT
        dc.id AS chunk_id,
        dc.material_id,
        dc.chunk_index,
        dc.chunk_text,
        1 - (dc.embedding <=> query_embedding) AS similarity,
        jsonb_build_object(
            'start_char', dc.start_char,
            'end_char', dc.end_char,
            'char_count', dc.char_count,
            'word_count', dc.word_count,
            'material_name', sm.file_url,
            'material_topic', sm.topic
        ) AS metadata
    FROM public.document_chunks dc
    JOIN public.study_materials sm ON dc.material_id = sm.id
    WHERE
        (dc.embedding <=> query_embedding) < (1 - match_threshold)
        AND (filter_user_id IS NULL OR dc.user_id = filter_user_id)
        AND (filter_material_id IS NULL OR dc.material_id = filter_material_id)
    ORDER BY dc.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

NOTIFY pgrst, 'reload schema';
