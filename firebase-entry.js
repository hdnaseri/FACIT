import { initializeApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail, fetchSignInMethodsForEmail } from "firebase/auth";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, addDoc, query, where, getDocs, getDocsFromCache, getDoc, onSnapshot, doc, updateDoc, deleteDoc, writeBatch, serverTimestamp, orderBy, limit, startAfter, increment, enableIndexedDbPersistence, enableMultiTabIndexedDbPersistence, setDoc, deleteField, getCountFromServer, FieldPath } from "firebase/firestore";

window.FirebaseBundle = {
    initializeApp,
    getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail, fetchSignInMethodsForEmail,
    getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, addDoc, query, where, getDocs, getDocsFromCache, getDoc, onSnapshot, doc, updateDoc, deleteDoc, writeBatch, serverTimestamp, orderBy, limit, startAfter, increment, enableIndexedDbPersistence, enableMultiTabIndexedDbPersistence, setDoc, deleteField, getCountFromServer, FieldPath
};
