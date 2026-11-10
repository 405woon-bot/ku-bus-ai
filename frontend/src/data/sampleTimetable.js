// 처음 열었을 때 보여 주는 예시 시간표(가상의 학생). 사용자가 지우거나 바꿀 수 있습니다.
export const SAMPLE_CLASSES = [
  { id: 's1', name: '자료구조', day: 0, start: '09:00', end: '10:15', building: '미래관', room: '301', color: 2 },
  { id: 's2', name: '자료구조', day: 2, start: '09:00', end: '10:15', building: '미래관', room: '301', color: 2 },
  { id: 's3', name: '운영체제', day: 1, start: '10:30', end: '11:45', building: '북악관', room: '605', color: 0 },
  { id: 's4', name: '운영체제', day: 3, start: '10:30', end: '11:45', building: '북악관', room: '605', color: 0 },
  { id: 's5', name: '확률과통계', day: 0, start: '13:30', end: '14:45', building: '공학관', room: '205', color: 1 },
  { id: 's6', name: '디지털논리', day: 1, start: '13:30', end: '14:45', building: '과학관', room: '310', color: 6 },
  { id: 's7', name: '기초영어회화', day: 2, start: '15:00', end: '16:15', building: '국제관', room: '201', color: 3 },
  { id: 's8', name: '캡스톤디자인', day: 3, start: '15:00', end: '17:50', building: '산학협력관', room: 'B103', color: 5 },
  { id: 's9', name: '웹프로그래밍', day: 4, start: '13:00', end: '15:50', building: '미래관', room: '409', color: 4 },
];

export const SAMPLE_TEXT = `자료구조 월수 09:00-10:15 미래관 301
운영체제 / 화,목 10:30~11:45 / 북악관 605
웹프로그래밍 금 5-7교시 미래관 409
데이터베이스 월1,2 수3 법학관 201`;
