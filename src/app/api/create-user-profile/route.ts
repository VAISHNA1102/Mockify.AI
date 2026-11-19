import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 }
      )
    }

    const body: unknown = await request.json()
    if (
      typeof body !== 'object' ||
      body === null ||
      !('userId' in body) ||
      !('email' in body) ||
      !('name' in body) ||
      typeof body.userId !== 'string' ||
      typeof body.email !== 'string' ||
      typeof body.name !== 'string' ||
      !body.userId ||
      !body.email ||
      !body.name
    ) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: userId, email, name' },
        { status: 400 }
      )
    }

    if (
      body.userId !== user.id ||
      body.email.toLowerCase() !== (user.email || '').toLowerCase()
    ) {
      return NextResponse.json(
        { success: false, error: 'Forbidden' },
        { status: 403 }
      )
    }

    const name = user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      user.email?.split('@')[0] ||
      'User'

    // Check if user profile already exists
    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('id')
      .eq('id', user.id)
      .maybeSingle()

    if (checkError) {
      console.error('[create-user-profile] Error checking existing user:', checkError)
      return NextResponse.json(
        { success: false, error: 'Failed to check user profile' },
        { status: 500 }
      )
    }

    if (existingUser) {
      return NextResponse.json({ 
        success: true, 
        message: 'User profile already exists' 
      })
    }

    const { error: insertError } = await supabase
      .from('users')
      .insert({
        id: user.id,
        email: user.email || '',
        name: name,
        created_at: new Date().toISOString(),
      })

    if (insertError) {
      console.error('[create-user-profile] Error creating user profile:', insertError)
      return NextResponse.json(
        { 
          success: false,
          error: 'Failed to create user profile'
        },
        { status: 500 }
      )
    }

    return NextResponse.json({ 
      success: true, 
      message: 'User profile created successfully' 
    })

  } catch (error) {
    console.error('[create-user-profile] Unexpected error:', error)
    return NextResponse.json(
      { 
        success: false,
        error: 'Internal server error'
      },
      { status: 500 }
    )
  }
}
