/**
 * Firebase 設定
 * 値を入力すると Cloud Firestore への保存が有効になります。
 * 未入力の場合は localStorage のみで動作します（画面は壊れません）。
 */
export const firebaseConfig = {
  apiKey: "AIzaSyAda33SWJ8Y_pfl6liH8lEsQ8d3dfohBAM",
  authDomain: "sakuragroupboard.firebaseapp.com",
  projectId: "sakuragroupboard",
  storageBucket: "sakuragroupboard.firebasestorage.app",
  messagingSenderId: "824532205118",
  appId: "1:824532205118:web:00eef55ea6e4ea81e69b6f",
  measurementId: "G-C9WJHKTEQZ"
};

/** 設定が揃っているか */
export function isFirebaseConfigured() {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.projectId &&
      firebaseConfig.appId
  );
}
