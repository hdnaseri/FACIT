import { initializeApp } from "firebase/app";
import { getAuth, initializeAuth, browserLocalPersistence, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail, fetchSignInMethodsForEmail } from "firebase/auth";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, persistentSingleTabManager, collection, addDoc, query, where, getDocs, getDocsFromCache, getDoc, onSnapshot, doc, updateDoc, deleteDoc, writeBatch, serverTimestamp, orderBy, limit, startAfter, increment, enableIndexedDbPersistence, enableMultiTabIndexedDbPersistence, setDoc, deleteField, getCountFromServer, FieldPath } from "firebase/firestore";

export {
    initializeApp,
    getAuth, initializeAuth, browserLocalPersistence, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail, fetchSignInMethodsForEmail,
    getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, persistentSingleTabManager, collection, addDoc, query, where, getDocs, getDocsFromCache, getDoc, onSnapshot, doc, updateDoc, deleteDoc, writeBatch, serverTimestamp, orderBy, limit, startAfter, increment, enableIndexedDbPersistence, enableMultiTabIndexedDbPersistence, setDoc, deleteField, getCountFromServer, FieldPath
};
