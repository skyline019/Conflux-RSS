import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import HomePage from "../src/app/page";

createRoot(document.getElementById("root")!).render(<HomePage />);
