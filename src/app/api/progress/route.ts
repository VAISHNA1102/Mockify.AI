import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient();
    
    // Get authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const examType = searchParams.get('examType');
    const topic = searchParams.get('topic');

    // Build query
    let query = supabase
      .from('user_progress')
      .select('*')
      .eq('user_id', user.id);

    if (examType) {
      query = query.eq('exam_type', examType);
    }

    if (topic) {
      query = query.eq('topic', topic);
    }

    query = query.order('last_attempted', { ascending: false });

    const { data: progressData, error: progressError } = await query;

    if (progressError) {
      console.error('Warning: could not fetch user_progress directly:', progressError);
    }

    // Get overall statistics with mock_tests join
    const { data: resultsData, error: resultsError } = await supabase
      .from('test_results')
      .select('id, score, total_questions, correct_answers, incorrect_answers, unattempted_answers, time_taken, completed_at, test_id, mock_tests(title, topic, exam_type)')
      .eq('user_id', user.id)
      .order('completed_at', { ascending: false })
      .limit(100);

    if (resultsError) {
      console.error('Error fetching results:', resultsError);
    }

    // Calculate overall stats
    const totalTests = resultsData?.length || 0;
    const averageScore = totalTests > 0
      ? resultsData!.reduce((sum: number, r: any) => sum + Number(r.score), 0) / totalTests
      : 0;
    const totalTimeSpent = resultsData?.reduce((sum: number, r: any) => sum + (r.time_taken || 0), 0) || 0;
    const totalQuestions = resultsData?.reduce((sum: number, r: any) => sum + (r.total_questions || 0), 0) || 0;
    const totalCorrect = resultsData?.reduce((sum: number, r: any) => sum + (r.correct_answers || 0), 0) || 0;
    const averageAccuracy = totalQuestions > 0
      ? (totalCorrect / totalQuestions) * 100
      : (totalTests > 0 ? averageScore : 0);
    const bestScore = totalTests > 0 
      ? Math.max(...resultsData!.map((r: any) => Number(r.score) || 0)) 
      : 0;

    // Get topic-wise performance from user_progress or directly from resultsData
    let topicWisePerformance: any[] = [];
    if (progressData && progressData.length > 0 && progressData.some(p => p.topic && p.topic !== 'General')) {
      topicWisePerformance = progressData.map((p: any) => ({
        topic: p.topic,
        tests_attempted: p.tests_attempted || 1,
        average_score: Math.round(Number(p.average_score)),
        accuracy: Math.round(Number(p.accuracy_rate) || Number(p.average_score)),
        highest_score: Math.round(Number(p.highest_score))
      }));
    } else if (resultsData && resultsData.length > 0) {
      const topicMap: Record<string, { totalScore: number; count: number; totalQs: number; correctQs: number; highest: number }> = {};
      
      resultsData.forEach((r: any) => {
        const mockTest = Array.isArray(r.mock_tests) ? r.mock_tests[0] : r.mock_tests;
        let topic = mockTest?.topic?.trim();
        if (!topic || topic === 'General') {
          topic = mockTest?.title?.split('-')[0]?.trim() || 'General';
        }
        if (!topicMap[topic]) {
          topicMap[topic] = { totalScore: 0, count: 0, totalQs: 0, correctQs: 0, highest: 0 };
        }
        const s = Number(r.score) || 0;
        topicMap[topic].totalScore += s;
        topicMap[topic].count += 1;
        topicMap[topic].totalQs += r.total_questions || 0;
        topicMap[topic].correctQs += r.correct_answers || 0;
        topicMap[topic].highest = Math.max(topicMap[topic].highest, s);
      });

      topicWisePerformance = Object.entries(topicMap).map(([topic, stats]) => ({
        topic,
        tests_attempted: stats.count,
        average_score: Math.round(stats.totalScore / stats.count),
        accuracy: stats.totalQs > 0 ? Math.round((stats.correctQs / stats.totalQs) * 100) : Math.round(stats.totalScore / stats.count),
        highest_score: stats.highest
      }));
    }

    // Determine strength and weakness
    const sortedByScore = [...topicWisePerformance].sort((a, b) => b.average_score - a.average_score);
    const strongTopics = sortedByScore.filter(t => t.average_score >= 60).slice(0, 3).map(t => t.topic);
    const weakTopics = sortedByScore.filter(t => t.average_score < 60).slice(-3).reverse().map(t => t.topic);

    // Topic distribution for pie chart
    const topicColors = ['#8b5cf6', '#6366f1', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#ec4899'];
    const totalTopicTests = topicWisePerformance.reduce((sum, t) => sum + t.tests_attempted, 0) || 1;
    const topicDistribution = topicWisePerformance.map((t, idx) => ({
      name: t.topic,
      value: Math.round((t.tests_attempted / totalTopicTests) * 100),
      count: t.tests_attempted,
      color: topicColors[idx % topicColors.length]
    }));

    // Chronological performance trend (for line chart)
    const chronologicalResults = [...(resultsData || [])].sort((a, b) => 
      new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime()
    );

    const performanceTrend = chronologicalResults.map((r: any, idx: number) => {
      const mockTest = Array.isArray(r.mock_tests) ? r.mock_tests[0] : r.mock_tests;
      const accuracy = r.total_questions > 0 
        ? Math.round((r.correct_answers / r.total_questions) * 100) 
        : Math.round(Number(r.score));
      return {
        test: `Test ${idx + 1}`,
        title: mockTest?.title || `Test ${idx + 1}`,
        date: new Date(r.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        score: Math.round(Number(r.score)),
        accuracy: accuracy,
        time_taken: r.time_taken,
        total_questions: r.total_questions,
        correct_answers: r.correct_answers
      };
    });

    // Recent tests list (descending)
    const recentTests = (resultsData || []).slice(0, 10).map((r: any) => {
      const mockTest = Array.isArray(r.mock_tests) ? r.mock_tests[0] : r.mock_tests;
      let topic = mockTest?.topic?.trim();
      if (!topic || topic === 'General') {
        topic = mockTest?.title?.split('-')[0]?.trim() || 'General';
      }
      return {
        id: r.id,
        test_id: r.test_id,
        title: mockTest?.title || 'Mock Test',
        topic,
        score: Math.round(Number(r.score)),
        accuracy: r.total_questions > 0 ? Math.round((r.correct_answers / r.total_questions) * 100) : Math.round(Number(r.score)),
        total_questions: r.total_questions,
        correct_answers: r.correct_answers,
        time_taken: r.time_taken,
        completed_at: r.completed_at
      };
    });

    const analytics = {
      overall_progress: {
        total_tests: totalTests,
        average_score: Math.round(averageScore),
        best_score: Math.round(bestScore),
        total_time_spent: totalTimeSpent,
        total_questions: totalQuestions,
        total_correct: totalCorrect,
        accuracy: Math.round(averageAccuracy)
      },
      topic_wise_performance: topicWisePerformance,
      strength_weakness: {
        strong_topics: strongTopics,
        weak_topics: weakTopics
      },
      topic_distribution: topicDistribution,
      performance_trend: performanceTrend,
      recent_tests: recentTests,
      improvement_trend: calculateImprovementTrend(resultsData || []),
      raw_progress: progressData || []
    };

    return NextResponse.json({ success: true, data: analytics });

  } catch (error) {
    console.error('Progress API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

function calculateImprovementTrend(results: any[]) {
  if (results.length === 0) return [];

  // Group by week
  const weeklyData: Record<string, { scores: number[], count: number }> = {};

  results.forEach(r => {
    const date = new Date(r.completed_at);
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - date.getDay());
    const weekKey = weekStart.toISOString().split('T')[0];

    if (!weeklyData[weekKey]) {
      weeklyData[weekKey] = { scores: [], count: 0 };
    }

    weeklyData[weekKey].scores.push(Number(r.score));
    weeklyData[weekKey].count++;
  });

  // Calculate average for each week
  const trend = Object.entries(weeklyData)
    .map(([date, data]) => ({
      date,
      average_score: Number((data.scores.reduce((a, b) => a + b, 0) / data.count).toFixed(2)),
      tests_count: data.count
    }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return trend;
}

export const dynamic = 'force-dynamic';
