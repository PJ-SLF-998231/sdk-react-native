import React from "react";
import { Text } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { SDK_NAME } from "../index";
import { cameraEntry } from "../camera";

test("renders and entries load", () => {
  render(<Text>{SDK_NAME}</Text>);
  expect(screen.getByText("@pj-slf-998231/sdk-react-native")).toBeTruthy();
  expect(cameraEntry).toBe("camera");
});
