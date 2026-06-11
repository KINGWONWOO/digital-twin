import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Supabase 환경 변수가 없습니다. .env.local 의 NEXT_PUBLIC_* 키를 확인하세요.'
  );
}

// 모듈 싱글톤: Fast Refresh/리렌더 시 커넥션 중복 생성 방지
export const supabase = createClient(url, anonKey, {
  realtime: { params: { eventsPerSecond: 10 } },
});
