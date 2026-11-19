"use client";

import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion } from 'motion/react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { 
  LineChart, Line, BarChart, Bar, XAxis, YAxis, 
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, 
  PieChart, Pie, Cell 
} from 'recharts';
import { 
  TrendingUp, Award, Target, BookOpen, Clock, 
  CheckCircle2, AlertCircle, ArrowRight, Zap, 
  Flame, BarChart3, ChevronRight, Check, X
} from 'lucide-react';
import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

interface ProgressData {
  overall_progress: {
    total_tests: number;
    average_score: number;
    best_score: number;
    total_time_spent: number;
    total_questions: number;
    total_correct: number;
    accuracy: number;
  };
  topic_wise_performance: Array<{
    topic: string;
    tests_attempted: number;
    average_score: number;
    accuracy: number;
    highest_score: number;
  }>;
  strength_weakness: {
    strong_topics: string[];
    weak_topics: string[];
  };
  topic_distribution: Array<{
    name: string;
    value: number;
    count: number;
    color: string;
  }>;
  performance_trend: Array<{
    test: string;
    title: string;
    date: string;
    score: number;
    accuracy: number;
    time_taken: number;
    total_questions: number;
    correct_answers: number;
  }>;
  recent_tests: Array<{
    id: string;
    test_id: string;
    title: string;
    topic: string;
    score: number;
    accuracy: number;
    total_questions: number;
    correct_answers: number;
    time_taken: number;
    completed_at: string;
  }>;
}

export function Progress() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  
  const [loading, setLoading] = useState<boolean>(true);
  const [examType, setExamType] = useState<string>('UPSC');
  const [studyStreak, setStudyStreak] = useState<number>(0);
  const [analytics, setAnalytics] = useState<ProgressData | null>(null);

  const fetchAnalytics = useCallback(async () => {
    try {
      setLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // 1. Fetch user profile for exam type
      const { data: userData } = await supabase
        .from('users')
        .select('exam_type, selected_exam')
        .eq('id', user.id)
        .single();

      if (userData) {
        setExamType((userData.selected_exam || userData.exam_type || 'UPSC').toUpperCase());
      }

      // 2. Fetch progress analytics API
      const res = await fetch('/api/progress');
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data) {
          setAnalytics(json.data);
        }
      }

      // 3. Compute streak
      const { data: results } = await supabase
        .from('test_results')
        .select('completed_at')
        .eq('user_id', user.id);

      const { data: tests } = await supabase
        .from('mock_tests')
        .select('created_at')
        .eq('user_id', user.id);

      const studyDates = new Set<string>();
      results?.forEach(r => {
        if (r.completed_at) studyDates.add(new Date(r.completed_at).toDateString());
      });
      tests?.forEach(t => {
        if (t.created_at) studyDates.add(new Date(t.created_at).toDateString());
      });

      let streak = 0;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const hasToday = studyDates.has(today.toDateString());
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const hasYesterday = studyDates.has(yesterday.toDateString());

      if (hasToday || hasYesterday) {
        const startOffset = hasToday ? 0 : 1;
        for (let i = startOffset; i < 365; i++) {
          const checkDate = new Date(today);
          checkDate.setDate(checkDate.getDate() - i);
          if (studyDates.has(checkDate.toDateString())) {
            streak++;
          } else {
            break;
          }
        }
      }
      setStudyStreak(streak);

    } catch (error) {
      console.error('Error loading analytics:', error);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  const stats = analytics?.overall_progress || {
    total_tests: 0,
    average_score: 0,
    best_score: 0,
    total_time_spent: 0,
    total_questions: 0,
    total_correct: 0,
    accuracy: 0
  };

  const performanceTrend = analytics?.performance_trend || [];
  const topicAnalysis = (analytics?.topic_wise_performance || []).map(t => ({
    topic: t.topic,
    strength: t.accuracy || t.average_score,
    weakness: Math.max(0, 100 - (t.accuracy || t.average_score)),
    tests: t.tests_attempted
  }));

  const timeDistribution = analytics?.topic_distribution || [];
  const recentTests = analytics?.recent_tests || [];
  const strongTopics = analytics?.strength_weakness?.strong_topics || [];
  const weakTopics = analytics?.strength_weakness?.weak_topics || [];

  const studyTimeHours = Math.round((stats.total_time_spent / 3600) * 10) / 10;

  return (
    <div className="p-3 sm:p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto space-y-4 sm:space-y-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4 sm:mb-8"
      >
        <div>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-900 dark:text-white mb-1">
            Progress & Analytics
          </h1>
          <p className="text-sm sm:text-base text-gray-600 dark:text-gray-400">
            Real-time insights and performance metrics across all your mock tests
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <Badge className="bg-linear-to-r from-violet-600 to-purple-600 text-white px-3 sm:px-4 py-1.5 sm:py-2 border-0 shadow-lg text-xs sm:text-sm font-semibold">
            <Target className="h-3 w-3 mr-1.5" />
            {examType} 2025
          </Badge>
          <Badge className="bg-white dark:bg-slate-800/50 backdrop-blur-sm border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-gray-300 px-3 sm:px-4 py-1.5 sm:py-2 shadow-sm text-xs sm:text-sm font-semibold">
            <Flame className="h-3 w-3 mr-1.5 text-orange-500" />
            {studyStreak} Day Streak
          </Badge>
        </div>
      </motion.div>

      {/* Summary Stat Cards */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4"
      >
        {[
          { 
            title: "Average Score", 
            value: `${stats.average_score}%`, 
            change: stats.total_tests > 0 ? `Across ${stats.total_tests} test${stats.total_tests > 1 ? 's' : ''}` : "Take tests to see score", 
            icon: TrendingUp, 
            gradient: "from-violet-600 to-purple-600" 
          },
          { 
            title: "Best Score", 
            value: `${stats.best_score}%`, 
            change: stats.best_score > 0 ? "Highest score achieved" : "No tests completed yet", 
            icon: Award, 
            gradient: "from-blue-600 to-cyan-600" 
          },
          { 
            title: "Tests Completed", 
            value: stats.total_tests.toString(), 
            change: `${stats.total_questions} questions attempted`, 
            icon: Target, 
            gradient: "from-emerald-600 to-teal-600" 
          },
          { 
            title: "Overall Accuracy", 
            value: `${stats.accuracy}%`, 
            change: `${stats.total_correct}/${stats.total_questions} correct answers`, 
            icon: BookOpen, 
            gradient: "from-amber-600 to-orange-600" 
          },
        ].map((stat, index) => {
          const Icon = stat.icon;
          return (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 + index * 0.05 }}
              className="group cursor-pointer"
              whileHover={{ 
                y: -4,
                transition: { duration: 0.2 }
              }}
            >
              <Card className="rounded-xl sm:rounded-2xl bg-[#F9F6F2] dark:bg-[#1a1a1a] border-2 sm:border-[3px] border-black dark:border-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] sm:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] sm:dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] group-hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] sm:group-hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] dark:group-hover:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] sm:dark:group-hover:shadow-[6px_6px_0px_0px_rgba(255,255,255,1)] transition-all duration-200">
                <CardHeader className="pb-1 sm:pb-2 p-3 sm:p-6">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-xs sm:text-sm text-[#555555] dark:text-gray-400 font-bold">{stat.title}</CardTitle>
                    <div className={`p-1.5 sm:p-2 rounded-lg bg-gradient-to-br ${stat.gradient} border-2 border-black dark:border-white shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.3)]`}>
                      <Icon className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-white" />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0">
                  <div className="text-xl sm:text-2xl font-bold text-black dark:text-white mb-0.5 sm:mb-1">
                    {loading ? "..." : stat.value}
                  </div>
                  <p className="text-[10px] sm:text-xs text-[#555555] dark:text-gray-400 font-medium truncate">{stat.change}</p>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </motion.div>

      {/* Performance Over Time Chart */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="group"
      >
        <Card className="rounded-xl sm:rounded-2xl bg-[#F9F6F2] dark:bg-[#1a1a1a] border-2 sm:border-[3px] border-black dark:border-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] sm:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] sm:dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] transition-all duration-200">
          <CardHeader className="p-4 sm:p-6 pb-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <CardTitle className="text-black dark:text-white text-lg sm:text-xl font-bold flex items-center gap-2">
                  <BarChart3 className="h-5 w-5" />
                  Performance Over Time
                </CardTitle>
                <p className="text-xs sm:text-sm text-[#555555] dark:text-gray-400 font-medium">
                  Your score and accuracy trends across mock tests
                </p>
              </div>
              {performanceTrend.length > 0 && (
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="bg-gradient-to-r from-violet-600 to-purple-600 border border-black dark:border-white text-white text-xs font-semibold px-2.5 py-0.5">
                    Score (%)
                  </Badge>
                  <Badge variant="outline" className="bg-gradient-to-r from-emerald-500 to-teal-600 border border-black dark:border-white text-white text-xs font-semibold px-2.5 py-0.5">
                    Accuracy (%)
                  </Badge>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-4 sm:p-6 pt-2">
            {performanceTrend.length > 0 ? (
              <div className="h-[260px] sm:h-[320px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={performanceTrend}>
                    <defs>
                      <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.3}/>
                        <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="accuracyGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity={0.3}/>
                        <stop offset="100%" stopColor="#10b981" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.25} />
                    <XAxis dataKey="test" stroke="#64748b" fontSize={12} />
                    <YAxis domain={[0, 100]} stroke="#64748b" fontSize={12} />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: '#0f172a', 
                        border: '2px solid #334155',
                        borderRadius: '12px',
                        color: '#fff',
                        boxShadow: '4px 4px 0px 0px rgba(0,0,0,0.5)'
                      }} 
                      formatter={(value: any, name: any) => [`${value}%`, name]}
                      labelFormatter={(label: any, payload: any) => {
                        const item = payload?.[0]?.payload;
                        return item ? `${item.title} (${item.date})` : label;
                      }}
                    />
                    <Legend wrapperStyle={{ color: '#94a3b8', paddingTop: '10px' }} />
                    <Line 
                      type="monotone" 
                      dataKey="score" 
                      stroke="#8b5cf6" 
                      strokeWidth={3} 
                      dot={{ fill: '#8b5cf6', r: 5, strokeWidth: 2, stroke: '#0f172a' }}
                      activeDot={{ r: 7 }}
                      name="Score (%)"
                    />
                    <Line 
                      type="monotone" 
                      dataKey="accuracy" 
                      stroke="#10b981" 
                      strokeWidth={3} 
                      dot={{ fill: '#10b981', r: 5, strokeWidth: 2, stroke: '#0f172a' }}
                      activeDot={{ r: 7 }}
                      name="Accuracy (%)"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="py-12 sm:py-16 text-center space-y-3">
                <div className="inline-flex p-4 rounded-full bg-violet-100 dark:bg-violet-950/50 text-violet-600 dark:text-violet-400 border-2 border-black dark:border-white shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.3)]">
                  <TrendingUp className="h-8 w-8" />
                </div>
                <h3 className="text-lg font-bold text-black dark:text-white">No Test Results Recorded Yet</h3>
                <p className="text-sm text-[#555555] dark:text-gray-400 max-w-md mx-auto">
                  Take a test from your Test Warehouse or generate a new one. Your score trends and accuracy over time will appear here automatically!
                </p>
                <div className="pt-2 flex items-center justify-center gap-3">
                  <Button 
                    onClick={() => router.push('/dashboard/test-history')}
                    className="bg-gradient-to-r from-violet-600 to-purple-600 text-white font-bold border-2 border-black dark:border-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:translate-y-[-2px] transition-transform"
                  >
                    Open Test Warehouse
                    <ArrowRight className="h-4 w-4 ml-1.5" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Topic Analysis & Study Distribution Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Topic-wise Analysis */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          className="lg:col-span-2 group"
        >
          <Card className="rounded-xl sm:rounded-2xl bg-[#F9F6F2] dark:bg-[#1a1a1a] border-2 sm:border-[3px] border-black dark:border-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] sm:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] sm:dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] transition-all duration-200 h-full">
            <CardHeader className="p-4 sm:p-6 pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-black dark:text-white font-bold text-lg sm:text-xl flex items-center gap-2">
                    <Target className="h-5 w-5" />
                    Topic-wise Analysis
                  </CardTitle>
                  <p className="text-xs sm:text-sm text-[#555555] dark:text-gray-400 font-medium">
                    Strengths vs areas for improvement across topics
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4 sm:p-6 pt-2 space-y-4">
              {topicAnalysis.length > 0 ? (
                <>
                  <div className="h-[260px] sm:h-[280px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={topicAnalysis} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.25} />
                        <XAxis type="number" domain={[0, 100]} stroke="#64748b" fontSize={12} unit="%" />
                        <YAxis dataKey="topic" type="category" stroke="#64748b" width={110} fontSize={12} />
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: '#0f172a', 
                            border: '2px solid #334155',
                            borderRadius: '12px',
                            color: '#fff',
                            boxShadow: '4px 4px 0px 0px rgba(0,0,0,0.5)'
                          }} 
                          formatter={(value: any, name: any) => [`${value}%`, name]}
                        />
                        <Legend wrapperStyle={{ color: '#94a3b8' }} />
                        <Bar dataKey="strength" fill="#3b82f6" radius={[0, 4, 4, 0]} name="Strength %" />
                        <Bar dataKey="weakness" fill="#ef4444" radius={[0, 4, 4, 0]} name="Weakness %" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Strengths & Weaknesses badges */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-gray-200 dark:border-gray-800">
                    <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-800">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-800 dark:text-emerald-300 mb-2">
                        <Check className="h-4 w-4" />
                        Strong Focus Areas
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {strongTopics.length > 0 ? strongTopics.map((topic, i) => (
                          <Badge key={i} className="bg-emerald-600 text-white font-medium text-xs">
                            {topic}
                          </Badge>
                        )) : (
                          <span className="text-xs text-emerald-700 dark:text-emerald-400">Keep practicing to identify top strengths</span>
                        )}
                      </div>
                    </div>

                    <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-300 dark:border-rose-800">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-rose-800 dark:text-rose-300 mb-2">
                        <AlertCircle className="h-4 w-4" />
                        Recommended for Review
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {weakTopics.length > 0 ? weakTopics.map((topic, i) => (
                          <Badge key={i} className="bg-rose-600 text-white font-medium text-xs">
                            {topic}
                          </Badge>
                        )) : (
                          <span className="text-xs text-rose-700 dark:text-rose-400">Great work! No weak topics detected yet</span>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="py-12 text-center text-[#555555] dark:text-gray-400">
                  <Target className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm font-semibold">No topic analysis available yet</p>
                  <p className="text-xs">Complete a test to discover your strengths and focus areas</p>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Study Distribution */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45 }}
          className="group"
        >
          <Card className="rounded-xl sm:rounded-2xl bg-[#F9F6F2] dark:bg-[#1a1a1a] border-2 sm:border-[3px] border-black dark:border-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] sm:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] sm:dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] transition-all duration-200 h-full flex flex-col">
            <CardHeader className="p-4 sm:p-6 pb-2">
              <CardTitle className="text-black dark:text-white font-bold text-lg sm:text-xl flex items-center gap-2">
                <Clock className="h-5 w-5" />
                Topic Distribution
              </CardTitle>
              <p className="text-xs sm:text-sm text-[#555555] dark:text-gray-400 font-medium">
                Tests completed by topic
              </p>
            </CardHeader>
            <CardContent className="p-4 sm:p-6 pt-2 flex-1 flex flex-col justify-between">
              {timeDistribution.length > 0 ? (
                <>
                  <div className="h-[200px] w-full flex items-center justify-center">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={timeDistribution}
                          cx="50%"
                          cy="50%"
                          innerRadius={50}
                          outerRadius={80}
                          paddingAngle={3}
                          dataKey="value"
                        >
                          {timeDistribution.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: '#0f172a', 
                            border: '2px solid #334155',
                            borderRadius: '12px',
                            color: '#fff',
                            boxShadow: '4px 4px 0px 0px rgba(0,0,0,0.5)'
                          }} 
                          formatter={(value: any, name: any) => [`${value}% of tests`, name]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="space-y-2 mt-4">
                    {timeDistribution.map((item, index) => (
                      <div key={index} className="flex items-center justify-between text-xs sm:text-sm">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: item.color }} />
                          <span className="text-gray-800 dark:text-gray-200 font-medium truncate max-w-[140px]">{item.name}</span>
                        </div>
                        <span className="text-[#555555] dark:text-gray-400 font-bold">{item.value}%</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="py-12 text-center text-[#555555] dark:text-gray-400 my-auto">
                  <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm font-semibold">No topic distribution yet</p>
                  <p className="text-xs">Take tests across different topics to see distribution</p>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Recent Test Attempts History */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
      >
        <Card className="rounded-xl sm:rounded-2xl bg-[#F9F6F2] dark:bg-[#1a1a1a] border-2 sm:border-[3px] border-black dark:border-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] sm:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] sm:dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] transition-all duration-200">
          <CardHeader className="p-4 sm:p-6 pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-black dark:text-white font-bold text-lg sm:text-xl flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5" />
                  Recent Test Attempts
                </CardTitle>
                <p className="text-xs sm:text-sm text-[#555555] dark:text-gray-400 font-medium">
                  Detailed score breakdown and results from your completed tests
                </p>
              </div>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => router.push('/dashboard/test-history')}
                className="border-2 border-black dark:border-white font-bold text-xs sm:text-sm shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.3)] hover:translate-x-0.5"
              >
                Warehouse
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-4 sm:p-6 pt-0">
            {recentTests.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b-2 border-black dark:border-white text-gray-600 dark:text-gray-400 font-bold">
                      <th className="py-2 sm:py-3 px-2 sm:px-4">Test Title</th>
                      <th className="py-2 sm:py-3 px-2 sm:px-4">Topic</th>
                      <th className="py-2 sm:py-3 px-2 sm:px-4">Date</th>
                      <th className="py-2 sm:py-3 px-2 sm:px-4">Score</th>
                      <th className="py-2 sm:py-3 px-2 sm:px-4">Accuracy</th>
                      <th className="py-2 sm:py-3 px-2 sm:px-4">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                    {recentTests.map((t) => {
                      const mins = Math.floor((t.time_taken || 0) / 60);
                      const secs = (t.time_taken || 0) % 60;
                      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                      const d = new Date(t.completed_at);
                      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

                      let badgeColor = "bg-rose-500 text-white";
                      if (t.score >= 75) badgeColor = "bg-emerald-600 text-white";
                      else if (t.score >= 50) badgeColor = "bg-amber-500 text-white";

                      return (
                        <tr key={t.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                          <td className="py-3 px-2 sm:px-4 font-bold text-black dark:text-white">{t.title}</td>
                          <td className="py-3 px-2 sm:px-4 text-gray-600 dark:text-gray-300">
                            <span className="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-xs">
                              {t.topic}
                            </span>
                          </td>
                          <td className="py-3 px-2 sm:px-4 text-gray-500 dark:text-gray-400">{dateStr}</td>
                          <td className="py-3 px-2 sm:px-4 font-bold">
                            <Badge className={`${badgeColor} border-2 border-black dark:border-white shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] text-xs`}>
                              {t.score}%
                            </Badge>
                          </td>
                          <td className="py-3 px-2 sm:px-4 text-gray-700 dark:text-gray-300 font-semibold">
                            {t.correct_answers}/{t.total_questions} ({t.accuracy}%)
                          </td>
                          <td className="py-3 px-2 sm:px-4 text-gray-500 dark:text-gray-400 font-medium">
                            {timeStr}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="py-10 text-center text-[#555555] dark:text-gray-400">
                <CheckCircle2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm font-semibold">No tests attempted yet</p>
                <p className="text-xs">Your completed tests will be listed here with detailed scores and stats</p>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
