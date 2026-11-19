    -- Remove the earlier owner-based write policies so clients cannot directly
    -- forge benchmark aggregates. RLS remains enabled and benchmark reads remain
    -- governed by the existing authenticated SELECT policy.
    DROP POLICY IF EXISTS "Users can insert benchmarks for own tests" ON public.benchmarks;
    DROP POLICY IF EXISTS "Users can update benchmarks for own tests" ON public.benchmarks;

    -- This trigger-only function writes benchmark aggregates after test_results
    -- RLS has accepted the result. It also checks test ownership before writing.
    CREATE OR REPLACE FUNCTION public.update_benchmarks_on_test_completion()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
        IF auth.uid() IS NOT NULL AND NEW.user_id IS DISTINCT FROM auth.uid() THEN
            RAISE EXCEPTION 'Test result user does not match the authenticated user'
                USING ERRCODE = '42501';
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM public.mock_tests AS mt
            WHERE mt.id = NEW.test_id
            AND mt.user_id = NEW.user_id
        ) THEN
            RAISE EXCEPTION 'Test result user does not own the submitted test'
                USING ERRCODE = '42501';
        END IF;

        INSERT INTO public.benchmarks (
            exam_type,
            topic,
            test_id,
            total_attempts,
            average_score,
            highest_score,
            average_time
        )
        SELECT
            mt.exam_type,
            COALESCE(mt.topic, 'Full Syllabus'),
            NEW.test_id,
            1,
            NEW.score,
            NEW.score,
            NEW.time_taken
        FROM public.mock_tests AS mt
        WHERE mt.id = NEW.test_id
        AND mt.user_id = NEW.user_id
        ON CONFLICT (exam_type, topic, test_id)
        DO UPDATE SET
            total_attempts = benchmarks.total_attempts + 1,
            average_score = (
                benchmarks.average_score * benchmarks.total_attempts + NEW.score
            ) / (benchmarks.total_attempts + 1),
            highest_score = GREATEST(benchmarks.highest_score, NEW.score),
            average_time = (
                benchmarks.average_time * benchmarks.total_attempts + NEW.time_taken
            ) / (benchmarks.total_attempts + 1),
            updated_at = NOW();

        RETURN NEW;
    END;
    $function$;
