import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }
    
    // Await params in Next.js 15+
    const { id } = await params;
    
    // Get material by ID
    const { data: material, error: fetchError } = await supabase
      .from('study_materials')
      .select('file_url')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();

    if (fetchError || !material) {
      return NextResponse.json(
        { error: 'Material not found' },
        { status: 404 }
      );
    }

    // Extract file path from URL
    const urlParts = material.file_url.split('/storage/v1/object/public/study-materials/');
    if (urlParts.length < 2) {
      return NextResponse.json(
        { error: 'Invalid file URL' },
        { status: 400 }
      );
    }
    
    const filePath = urlParts[1];

    // Generate signed URL (valid for 1 hour)
    const { data: signedUrlData, error: signedError } = await supabase.storage
      .from('study-materials')
      .createSignedUrl(filePath, 3600);

    if (signedError || !signedUrlData) {
      console.error('Error generating signed URL:', signedError);
      return NextResponse.json(
        { error: 'Failed to generate download URL' },
        { status: 500 }
      );
    }

    // Redirect to the signed URL
    const response = NextResponse.redirect(signedUrlData.signedUrl);
    response.headers.set('Cache-Control', 'private, no-store, max-age=0');
    return response;
  } catch (error) {
    console.error('Download error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
