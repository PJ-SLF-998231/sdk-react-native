import React from "react";
import { Text } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { SDK_NAME } from "../index";
import { CameraButton } from "../camera";
import { DocumentPickerButton } from "../picker";

test("renders and entries load", () => {
  render(<Text>{SDK_NAME}</Text>);
  expect(screen.getByText("@pj-slf-998231/sdk-react-native")).toBeTruthy();
  expect(typeof CameraButton).toBe("function");
  expect(typeof DocumentPickerButton).toBe("function");
});
