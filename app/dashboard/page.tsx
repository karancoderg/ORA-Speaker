'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import DashboardLayout from '@/components/DashboardLayout';
import MainHeader from '@/components/MainHeader';
import EmptyState from '@/components/EmptyState';
import UploadBox from '@/components/UploadBox';
import VideoPreview from '@/components/VideoPreview';
import FeedbackCard from '@/components/FeedbackCard';
import { FadeIn, SlideUp } from '@/components/AnimationWrappers';
import { motion, AnimatePresence } from 'framer-motion';
import { FeedbackSession } from '@/lib/types';

interface DashboardState {
  uploadedVideo: {
    path: string;
    url: string;
  } | null;
  isUploading: boolean;
  uploadProgress: number;
  isAnalyzing: boolean;
  feedback: string | null;
  error: string | null;
  showUploadBox: boolean;
  feedbackHistory: FeedbackSession[];
  selectedFeedbackId: string | null;
  isLoadingHistory: boolean;
  historyError: string | null;
}

export default function Dashboard({ onMenuClick }: { onMenuClick?: () => void }) {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const uploadBoxRef = useRef<HTMLDivElement>(null);
  
  const [state, setState] = useState<DashboardState>({
    uploadedVideo: null,
    isUploading: false,
    uploadProgress: 0,
    isAnalyzing: false,
    feedback: null,
    error: null,
    showUploadBox: false,
    feedbackHistory: [],
    selectedFeedbackId: null,
    isLoadingHistory: false,
    historyError: null,
  });

  useEffect(() => {
    // Check authentication status
    const checkAuth = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        
        if (!session) {
          router.push('/');
          return;
        }

        setUserId(session.user.id);
        setUserEmail(session.user.email || null);
      } catch (error) {
        console.error('Auth check error:', error);
        router.push('/');
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, [router]);

  // Fetch feedback history function
  const fetchFeedbackHistory = async () => {
    if (!userId) return;
    
    setState(prev => ({ ...prev, isLoadingHistory: true }));
    
    try {
      // Determine limit based on screen size
      // Mobile (<768px): 5 items, Desktop (>=768px): 10 items
      const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
      const limit = isMobile ? 5 : 10;
      
      const { data, error } = await supabase
        .from('feedback_sessions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      
      if (error) throw error;
      
      setState(prev => ({
        ...prev,
        feedbackHistory: data || [],
        isLoadingHistory: false,
        historyError: null,
      }));
    } catch (error) {
      console.error('Error fetching feedback history:', error);
      setState(prev => ({
        ...prev,
        isLoadingHistory: false,
        historyError: 'Failed to load feedback history',
      }));
    }
  };

  // Fetch feedback history when userId is available
  useEffect(() => {
    fetchFeedbackHistory();
  }, [userId]);

  // Refetch feedback history on window resize (mobile <-> desktop transition)
  useEffect(() => {
    let previousIsMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    
    const handleResize = () => {
      const currentIsMobile = window.innerWidth < 768;
      // Only refetch if we crossed the mobile/desktop threshold
      if (currentIsMobile !== previousIsMobile) {
        previousIsMobile = currentIsMobile;
        fetchFeedbackHistory();
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [userId]);

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
      router.push('/');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const handleSelectFeedback = async (session: FeedbackSession) => {
    // Update state to set selected feedback and clear upload mode
    setState(prev => ({
      ...prev,
      selectedFeedbackId: session.id,
      feedback: session.feedback_text,
      uploadedVideo: null,
      showUploadBox: false,
      error: null,
    }));

    // Generate pre-signed URL for the video
    try {
      // Get current session for auth token
      const { data: { session: authSession } } = await supabase.auth.getSession();
      
      if (!authSession) {
        throw new Error('Authentication required');
      }

      const response = await fetch('/api/preview-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authSession.access_token}`,
        },
        body: JSON.stringify({ s3Key: session.video_path }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load video preview');
      }

      // Update uploadedVideo state with path and URL
      setState(prev => ({
        ...prev,
        uploadedVideo: {
          path: session.video_path,
          url: data.previewUrl,
        },
      }));
    } catch (error) {
      console.error('Error loading video preview:', error);
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to load video preview. Please try again.',
      }));
    }

    // Close mobile sidebar after selection (check window width < 1024px)
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      // Trigger sidebar close - this will be handled by DashboardLayout
      const event = new CustomEvent('closeMobileSidebar');
      window.dispatchEvent(event);
    }
  };

  const handleUploadComplete = (videoPath: string, videoUrl: string) => {
    console.log('✅ Upload complete!');
    console.log('S3 Key (path):', videoPath);
    console.log('S3 URL:', videoUrl);
    
    setState((prev) => ({
      ...prev,
      uploadedVideo: { path: videoPath, url: videoUrl },
      isUploading: false,
      uploadProgress: 100,
      error: null,
      showUploadBox: true, // Keep upload box visible after upload
    }));
  };

  const handleUploadProgress = (progress: number) => {
    setState((prev) => ({
      ...prev,
      uploadProgress: progress,
      isUploading: progress < 100,
    }));
  };

  const handleUploadError = (error: string) => {
    setState((prev) => ({
      ...prev,
      error,
      isUploading: false,
      uploadProgress: 0,
    }));
  };

  const handleUploadClick = () => {
    // Clear selected feedback when entering upload mode
    setState((prev) => ({
      ...prev,
      showUploadBox: true,
      selectedFeedbackId: null,
      uploadedVideo: null,
      feedback: null,
      error: null,
    }));
    
    // Scroll to upload box after it's rendered
    setTimeout(() => {
      if (uploadBoxRef.current) {
        uploadBoxRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  };

  const handleMyVideosClick = () => {
    // Clear selection and show upload interface
    setState((prev) => ({
      ...prev,
      selectedFeedbackId: null,
      showUploadBox: false,
      uploadedVideo: null,
      feedback: null,
      error: null,
    }));
  };

  const handleAnalyzeVideo = async () => {
    if (!state.uploadedVideo || !userId) {
      return;
    }

    // Set analyzing state
    setState((prev) => ({
      ...prev,
      isAnalyzing: true,
      error: null,
      feedback: null,
    }));

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId,
          videoPath: state.uploadedVideo.path,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to analyze video');
      }

      // Update state with feedback and selected feedback ID
      setState((prev) => ({
        ...prev,
        feedback: data.feedback,
        selectedFeedbackId: data.feedbackSessionId,
        isAnalyzing: false,
        error: null,
      }));

      // Refresh feedback history to show the new feedback at the top
      await fetchFeedbackHistory();
    } catch (error) {
      console.error('Analysis error:', error);
      setState((prev) => ({
        ...prev,
        isAnalyzing: false,
        error: error instanceof Error ? error.message : 'Failed to analyze video. Please try again.',
      }));
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900" />
        <div className="relative z-10 flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
            <p className="mt-4 text-slate-300">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <DashboardLayout 
      userEmail={userEmail} 
      onLogout={handleLogout}
      feedbackHistory={state.feedbackHistory}
      selectedFeedbackId={state.selectedFeedbackId}
      onSelectFeedback={handleSelectFeedback}
      isLoadingHistory={state.isLoadingHistory}
      onMyVideosClick={handleMyVideosClick}
    >
      <MainHeader
        title="Your Videos"
        subtitle="Upload and analyze your public speaking performances"
        onUploadClick={handleUploadClick}
        onMenuClick={onMenuClick}
      />

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        {/* Conditional rendering: Show EmptyState when no video and upload box not shown, otherwise show upload/video components */}
        <AnimatePresence mode="wait">
          {!state.uploadedVideo && !state.isUploading && !state.showUploadBox && !state.feedback ? (
            <EmptyState key="empty-state" onUploadClick={handleUploadClick} />
          ) : (
            <motion.div
              key={`content-${state.showUploadBox ? 'upload' : state.selectedFeedbackId || 'default'}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="space-y-8 max-w-5xl mx-auto"
            >
            {/* Upload Section - Only show when explicitly requested or during upload */}
            {(state.showUploadBox || state.isUploading) && (
              <div ref={uploadBoxRef}>
                <SlideUp delay={0.1}>
                  <div className="backdrop-blur-xl bg-white/10 border border-white/20 rounded-2xl shadow-lg p-6 hover:border-white/30 hover:shadow-xl transition-all duration-300">
                    <h3 className="text-lg font-semibold text-white mb-4">
                      Upload Video
                    </h3>
                    <UploadBox
                      onUploadComplete={handleUploadComplete}
                      onUploadProgress={handleUploadProgress}
                      onError={handleUploadError}
                    />
                  </div>
                </SlideUp>
              </div>
            )}

            {/* Video Preview Section */}
            {state.uploadedVideo && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
              >
                <VideoPreview
                  videoUrl={state.uploadedVideo.url}
                  videoPath={state.uploadedVideo.path}
                />

                {/* Analyze Video Button */}
                {!state.feedback && (
                  <FadeIn delay={0.1}>
                    <div className="backdrop-blur-xl bg-white/10 border border-white/20 rounded-2xl shadow-lg p-6 mt-6 hover:border-white/30 transition-all duration-300">
                      <div className="text-center">
                        <button
                          onClick={handleAnalyzeVideo}
                          disabled={state.isAnalyzing}
                          className={`px-8 py-3 text-white font-semibold rounded-xl transition-all duration-300 shadow-lg min-h-[44px] focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 focus:ring-offset-slate-900 ${
                            state.isAnalyzing
                              ? 'bg-gradient-to-r from-blue-400 to-purple-400 cursor-not-allowed opacity-70'
                              : 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(59,130,246,0.5)]'
                          }`}
                        >
                          {state.isAnalyzing ? (
                            <span className="flex items-center justify-center">
                              <svg
                                className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
                                xmlns="http://www.w3.org/2000/svg"
                                fill="none"
                                viewBox="0 0 24 24"
                              >
                                <circle
                                  className="opacity-25"
                                  cx="12"
                                  cy="12"
                                  r="10"
                                  stroke="currentColor"
                                  strokeWidth="4"
                                ></circle>
                                <path
                                  className="opacity-75"
                                  fill="currentColor"
                                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                ></path>
                              </svg>
                              Analyzing...
                            </span>
                          ) : (
                            'Analyze Video'
                          )}
                        </button>
                        {state.isAnalyzing && (
                          <p className="mt-4 text-sm text-slate-400">
                            Please wait while we analyze your video. This may take a moment.
                          </p>
                        )}
                      </div>
                    </div>
                  </FadeIn>
                )}
              </motion.div>
            )}

            {/* Feedback Section */}
            {state.feedback && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.2 }}
              >
                <FeedbackCard
                  feedback={state.feedback}
                  isLoading={state.isAnalyzing}
                />
              </motion.div>
            )}

            {/* Error Display */}
            {state.error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
              >
                <div className="backdrop-blur-lg bg-red-500/10 border border-red-500/50 rounded-2xl p-4">
                  <div className="flex items-start gap-3">
                    <svg
                      className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <p className="text-sm text-red-200 flex-1">{state.error}</p>
                  </div>
                </div>
              </motion.div>
            )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </DashboardLayout>
  );
}
