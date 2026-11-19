"use client";

import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, CheckCircle2, Clock } from 'lucide-react';
import { Button } from './ui/button';
import { createClient } from '@/lib/supabase';

const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

interface CalendarDay {
  date: number;
  isCurrentMonth: boolean;
  hasTest?: boolean;
  completed?: boolean;
  studyMinutes?: number;
  scheduledCount?: number;
  isToday?: boolean;
  dateStr: string;
}

interface DayData {
  scheduledTestCount: number;
  completedTests: number;
  studyMinutes: number;
}

export function StudyCalendar() {
  const today = new Date();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [calendarData, setCalendarData] = useState<Map<string, DayData>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const supabase = useMemo(() => createClient(), []);

  // Fetch calendar data for the current month
  useEffect(() => {
    const fetchCalendarData = async () => {
      setIsLoading(true);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        const year = currentDate.getFullYear();
        const month = currentDate.getMonth();
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);

        const startDate = firstDay.toISOString().split('T')[0];
        const endDate = lastDay.toISOString().split('T')[0];

        // Fetch scheduled tests safely
        let scheduledTests: any[] = [];
        try {
          const { data } = await supabase
            .from('scheduled_tests')
            .select('scheduled_date')
            .eq('user_id', user.id)
            .gte('scheduled_date', startDate)
            .lte('scheduled_date', endDate);
          if (data) scheduledTests = data;
        } catch {
          // scheduled_tests table might not exist
        }

        // Fetch completed tests
        const { data: completedTests } = await supabase
          .from('test_results')
          .select('completed_at, time_taken')
          .eq('user_id', user.id)
          .gte('completed_at', startDate)
          .lte('completed_at', endDate);

        // Fetch created mock tests
        const { data: createdTests } = await supabase
          .from('mock_tests')
          .select('created_at')
          .eq('user_id', user.id)
          .gte('created_at', startDate)
          .lte('created_at', endDate);

        const dataMap = new Map<string, DayData>();

        scheduledTests?.forEach((test) => {
          const dateStr = test.scheduled_date;
          if (!dataMap.has(dateStr)) {
            dataMap.set(dateStr, { scheduledTestCount: 0, completedTests: 0, studyMinutes: 0 });
          }
          dataMap.get(dateStr)!.scheduledTestCount += 1;
        });

        completedTests?.forEach((test) => {
          const dateStr = test.completed_at.split('T')[0];
          if (!dataMap.has(dateStr)) {
            dataMap.set(dateStr, { scheduledTestCount: 0, completedTests: 0, studyMinutes: 0 });
          }
          const d = dataMap.get(dateStr)!;
          d.completedTests += 1;
          d.studyMinutes += Math.round((test.time_taken || 0) / 60);
        });

        createdTests?.forEach((test) => {
          const dateStr = test.created_at.split('T')[0];
          if (!dataMap.has(dateStr)) {
            dataMap.set(dateStr, { scheduledTestCount: 0, completedTests: 0, studyMinutes: 0 });
          }
          dataMap.get(dateStr)!.completedTests += 1;
        });

        setCalendarData(dataMap);
      } catch (error) {
        console.error('Error fetching calendar data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchCalendarData();
  }, [currentDate, supabase]);

  const getDaysInMonth = (date: Date): CalendarDay[] => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay();

    const days: CalendarDay[] = [];

    // Previous month days
    const prevMonthLastDay = new Date(year, month, 0).getDate();
    for (let i = startingDayOfWeek - 1; i >= 0; i--) {
      days.push({
        date: prevMonthLastDay - i,
        isCurrentMonth: false,
        dateStr: ''
      });
    }

    // Current month days
    const isCurrentMonthAndYear = 
      month === today.getMonth() && year === today.getFullYear();
    
    for (let i = 1; i <= daysInMonth; i++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      const dayData = calendarData.get(dateStr);
      
      days.push({
        date: i,
        isCurrentMonth: true,
        dateStr,
        hasTest: (dayData?.scheduledTestCount || 0) > 0,
        completed: (dayData?.completedTests || 0) > 0,
        studyMinutes: dayData?.studyMinutes || 0,
        scheduledCount: dayData?.scheduledTestCount || 0,
        isToday: isCurrentMonthAndYear && i === today.getDate(),
      });
    }

    // Next month days to fill 35 or 42 grid
    const totalSlots = days.length > 35 ? 42 : 35;
    const remainingDays = totalSlots - days.length;
    for (let i = 1; i <= remainingDays; i++) {
      days.push({
        date: i,
        isCurrentMonth: false,
        dateStr: ''
      });
    }

    return days;
  };

  const days = getDaysInMonth(currentDate);

  const nextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1));
  };

  const prevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1));
  };

  return (
    <div className="space-y-3">
      {/* Month Navigation Header */}
      <div className="flex items-center justify-between pb-1">
        <h3 className="text-sm sm:text-base font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
          <span>{months[currentDate.getMonth()]}</span>
          <span className="text-gray-500 dark:text-gray-400 font-medium">{currentDate.getFullYear()}</span>
        </h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={prevMonth}
            className="h-7 w-7 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-800"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={nextMonth}
            className="h-7 w-7 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-slate-800"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Weekday headers */}
      <div className="grid grid-cols-7 gap-1 text-center">
        {daysOfWeek.map((day) => (
          <div key={day} className="text-[11px] font-bold text-gray-400 dark:text-gray-500 py-1">
            {day.slice(0, 1)}
          </div>
        ))}
      </div>

      {/* Days Grid */}
      <AnimatePresence mode="wait">
        <motion.div
          key={`${currentDate.getMonth()}-${currentDate.getFullYear()}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="grid grid-cols-7 gap-1"
        >
          {days.map((day, index) => {
            const isToday = day.isToday;
            const hasActivity = day.completed;
            const hasScheduled = day.hasTest;

            return (
              <div
                key={`${index}-${day.date}`}
                className={`
                  relative h-9 sm:h-10 flex flex-col items-center justify-center rounded-lg text-xs font-semibold transition-all
                  ${!day.isCurrentMonth 
                    ? 'text-gray-300 dark:text-gray-700 pointer-events-none' 
                    : 'text-gray-800 dark:text-gray-200 hover:bg-violet-50 dark:hover:bg-slate-800/80 cursor-pointer'}
                  ${isToday 
                    ? 'bg-violet-600 text-white font-bold shadow-md shadow-violet-500/20 hover:bg-violet-700' 
                    : ''}
                  ${hasActivity && !isToday 
                    ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-300 font-bold border border-emerald-300 dark:border-emerald-800/50' 
                    : ''}
                `}
                title={
                  day.isCurrentMonth
                    ? `${day.date} ${months[currentDate.getMonth()]}${day.completed ? ' - Activity Recorded' : ''}${day.hasTest ? ' - Test Scheduled' : ''}`
                    : ''
                }
              >
                <span>{day.date}</span>
                
                {/* Subtle indicator dots */}
                <div className="flex items-center gap-0.5 mt-0.5 h-1">
                  {hasActivity && (
                    <span className={`w-1 h-1 rounded-full ${isToday ? 'bg-white' : 'bg-emerald-500'}`} />
                  )}
                  {hasScheduled && (
                    <span className="w-1 h-1 rounded-full bg-blue-500" />
                  )}
                </div>
              </div>
            );
          })}
        </motion.div>
      </AnimatePresence>

      {/* Clean, minimal Legend */}
      <div className="flex items-center justify-center gap-4 text-[11px] pt-2 border-t border-gray-200 dark:border-slate-800 text-gray-500 dark:text-gray-400 font-medium">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-violet-600" />
          <span>Today</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          <span>Active / Completed</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-blue-500" />
          <span>Scheduled</span>
        </div>
      </div>
    </div>
  );
}
